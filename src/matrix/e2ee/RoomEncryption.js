/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {MEGOLM_ALGORITHM, DecryptionSource} from "./common.js";
import {groupEventsBySession} from "./megolm/decryption/utils.js";
import {mergeMap} from "../../utils/mergeMap.js";
import {groupBy} from "../../utils/groupBy.js";
import {makeTxnId} from "../common.js";

const ENCRYPTED_TYPE = "m.room.encrypted";
// how often ensureMessageKeyIsShared can check if it needs to
// create a new outbound session
// note that encrypt could still create a new session
const MIN_PRESHARE_INTERVAL = 60 * 1000; // 1min

// TODO: this class is a good candidate for splitting up into encryption and decryption, there doesn't seem to be much overlap
export class RoomEncryption {
    constructor({room, deviceTracker, olmEncryption, megolmEncryption, megolmDecryption, encryptionParams, storage, sessionBackup, notifyMissingMegolmSession, clock}) {
        this._room = room;
        this._deviceTracker = deviceTracker;
        this._olmEncryption = olmEncryption;
        this._megolmEncryption = megolmEncryption;
        this._megolmDecryption = megolmDecryption;
        // content of the m.room.encryption event
        this._encryptionParams = encryptionParams;
        this._megolmBackfillCache = this._megolmDecryption.createSessionCache();
        this._megolmSyncCache = this._megolmDecryption.createSessionCache(1);
        // caches devices to verify events
        this._senderDeviceCache = new Map();
        this._storage = storage;
        this._sessionBackup = sessionBackup;
        this._notifyMissingMegolmSession = notifyMissingMegolmSession;
        this._clock = clock;
        this._isFlushingRoomKeyShares = false;
        this._lastKeyPreShareTime = null;
        this._disposed = false;
    }

    enableSessionBackup(sessionBackup) {
        if (this._sessionBackup) {
            return;
        }
        this._sessionBackup = sessionBackup;
    }

    async restoreMissingSessionsFromBackup(entries, log) {
        const events = entries.filter(e => e.isEncrypted && !e.isDecrypted && e.event).map(e => e.event);
        const eventsBySession = groupEventsBySession(events);
        const groups = Array.from(eventsBySession.values());
        const txn = await this._storage.readTxn([this._storage.storeNames.inboundGroupSessions]);
        const hasSessions = await Promise.all(groups.map(async group => {
            return this._megolmDecryption.hasSession(this._room.id, group.senderKey, group.sessionId, txn);
        }));
        const missingSessions = groups.filter((_, i) => !hasSessions[i]);
        if (missingSessions.length) {
            // start with last sessions which should be for the last items in the timeline
            for (var i = missingSessions.length - 1; i >= 0; i--) {
                const session = missingSessions[i];
                await log.wrap("session", log => this._requestMissingSessionFromBackup(session.senderKey, session.sessionId, log));
            }
        }
    }

    notifyTimelineClosed() {
        // empty the backfill cache when closing the timeline
        this._megolmBackfillCache.dispose();
        this._megolmBackfillCache = this._megolmDecryption.createSessionCache();
        this._senderDeviceCache = new Map();    // purge the sender device cache
    }

    async writeMemberChanges(memberChanges, txn, log) {
        let shouldFlush;
        const memberChangesArray = Array.from(memberChanges.values());
        if (memberChangesArray.some(m => m.hasLeft)) {
            log.log({
                l: "discardOutboundSession",
                leftUsers: memberChangesArray.filter(m => m.hasLeft).map(m => m.userId),
            });
            this._megolmEncryption.discardOutboundSession(this._room.id, txn);
        }
        if (memberChangesArray.some(m => m.hasJoined)) {
            shouldFlush = await this._addShareRoomKeyOperationForNewMembers(memberChangesArray, txn, log);
        }
        await this._deviceTracker.writeMemberChanges(this._room, memberChanges, txn);
        return shouldFlush;
    }

    async prepareDecryptAll(events, newKeys, source, txn) {
        const errors = new Map();
        const validEvents = [];
        for (const event of events) {
            if (event.redacted_because || event.unsigned?.redacted_because) {
                continue;
            }
            if (event.content?.algorithm !== MEGOLM_ALGORITHM) {
                errors.set(event.event_id, new Error("Unsupported algorithm: " + event.content?.algorithm));
            }
            validEvents.push(event);
        }
        let customCache;
        let sessionCache;
        // we have different caches so we can keep them small but still
        // have backfill and sync not invalidate each other
        if (source === DecryptionSource.Sync) {
            sessionCache = this._megolmSyncCache;
        } else if (source === DecryptionSource.Timeline) {
            sessionCache = this._megolmBackfillCache;
        } else if (source === DecryptionSource.Retry) {
            // when retrying, we could have mixed events from at the bottom of the timeline (sync)
            // and somewhere else, so create a custom cache we use just for this operation.
            customCache = this._megolmDecryption.createSessionCache();
            sessionCache = customCache;
        } else {
            throw new Error("Unknown source: " + source);
        }
        const preparation = await this._megolmDecryption.prepareDecryptAll(
            this._room.id, validEvents, newKeys, sessionCache, txn);
        if (customCache) {
            customCache.dispose();
        }
        return new DecryptionPreparation(preparation, errors, source, this, events);
    }

    async _processDecryptionResults(events, results, errors, source, txn, log) {
        const missingSessionEvents = events.filter(event => {
            const error = errors.get(event.event_id);
            return error?.code === "MEGOLM_NO_SESSION";
        });
        if (!missingSessionEvents.length) {
            return;
        }
        // store missing event ids if received from sync
        const missingEventsBySession = groupEventsBySession(missingSessionEvents);
        if (source === DecryptionSource.Sync) {
            await Promise.all(Array.from(missingEventsBySession.values()).map(async group => {
                const eventIds = group.events.map(e => e.event_id);
                return this._megolmDecryption.addMissingKeyEventIds(
                    this._room.id, group.senderKey, group.sessionId, eventIds, txn);
            }));
        }
        
        if (!this._sessionBackup) {
            return;
        }

        log.wrapDetached("check key backup", async log => {
            // if the message came from sync, wait 10s to see if the room key arrives late,
            // and only after that proceed to request from backup
            log.set("source", source);
            log.set("events", missingSessionEvents.length);
            log.set("sessions", missingEventsBySession.size);
            if (source === DecryptionSource.Sync) {
                await this._clock.createTimeout(10000).elapsed();
                if (this._disposed) {
                    return;
                }
                // now check which sessions have been received already
                const txn = await this._storage.readTxn([this._storage.storeNames.inboundGroupSessions]);
                await Promise.all(Array.from(missingEventsBySession).map(async ([key, group]) => {
                    if (await this._megolmDecryption.hasSession(this._room.id, group.senderKey, group.sessionId, txn)) {
                        missingEventsBySession.delete(key);
                    }
                }));
            }
            await Promise.all(Array.from(missingEventsBySession.values()).map(group => {
                return log.wrap("session", log => this._requestMissingSessionFromBackup(group.senderKey, group.sessionId, log));
            }));
        });
    }

    async _verifyDecryptionResult(result, txn) {
        let device = this._senderDeviceCache.get(result.senderCurve25519Key);
        if (!device) {
            device = await this._deviceTracker.getDeviceByCurve25519Key(result.senderCurve25519Key, txn);
            this._senderDeviceCache.set(result.senderCurve25519Key, device);
        }
        if (device) {
            result.setDevice(device);
        } else if (!this._room.isTrackingMembers) {
            result.setRoomNotTrackedYet();
        }
    }

    async _requestMissingSessionFromBackup(senderKey, sessionId, log) {
        // show prompt to enable secret storage
        if (!this._sessionBackup) {
            log.set("enabled", false);
            this._notifyMissingMegolmSession();
            return;
        }
        log.set("id", sessionId);
        log.set("senderKey", senderKey);           
        try {
            const session = await this._sessionBackup.getSession(this._room.id, sessionId, log);
            if (session?.algorithm === MEGOLM_ALGORITHM) {
                if (session["sender_key"] !== senderKey) {
                    log.set("wrong_sender_key", session["sender_key"]);
                    log.logLevel = log.level.Warn;
                    return;
                }
                let roomKey = this._megolmDecryption.roomKeyFromBackup(this._room.id, sessionId, session);
                if (roomKey) {
                    let keyIsBestOne = false;
                    let retryEventIds;
                    try {
                        const txn = await this._storage.readWriteTxn([this._storage.storeNames.inboundGroupSessions]);
                        try {
                            keyIsBestOne = await this._megolmDecryption.writeRoomKey(roomKey, txn);
                            log.set("isBetter", keyIsBestOne);
                            if (keyIsBestOne) {
                                retryEventIds = roomKey.eventIds;
                            }
                        } catch (err) {
                            txn.abort();
                            throw err;
                        }
                        await txn.complete();
                    } finally {
                        // can still access properties on it afterwards
                        // this is just clearing the internal sessionInfo
                        roomKey.dispose();
                    }
                    if (keyIsBestOne) {
                        await log.wrap("retryDecryption", log => this._room.notifyRoomKey(roomKey, retryEventIds || [], log));
                    }
                }
            } else if (session?.algorithm) {
                log.set("unknown algorithm", session.algorithm);
            }
        } catch (err) {
            if (!(err.name === "HomeServerError" && err.errcode === "M_NOT_FOUND")) {
                log.set("not_found", true);
            } else {
                log.error = err;
                log.logLevel = log.level.Error;
            }
        }
    }

    /**
     * @param  {RoomKey} roomKeys
     * @param {Transaction} txn
     * @return {Promise<Array<string>>} the event ids that should be retried to decrypt
     */
    getEventIdsForMissingKey(roomKey, txn) {
        return this._megolmDecryption.getEventIdsForMissingKey(this._room.id, roomKey.senderKey, roomKey.sessionId, txn);
    }

    /** shares the encryption key for the next message if needed */
    async ensureMessageKeyIsShared(hsApi, log) {
        if (this._lastKeyPreShareTime?.measure() < MIN_PRESHARE_INTERVAL) {
            return;
        }
        this._lastKeyPreShareTime = this._clock.createMeasure();
        const roomKeyMessage = await this._megolmEncryption.ensureOutboundSession(this._room.id, this._encryptionParams);
        if (roomKeyMessage) {
            await log.wrap("share key", log => this._shareNewRoomKey(roomKeyMessage, hsApi, log));
        }
    }

    async encrypt(type, content, hsApi, log) {
        const megolmResult = await log.wrap("megolm encrypt", () => this._megolmEncryption.encrypt(this._room.id, type, content, this._encryptionParams));
        if (megolmResult.roomKeyMessage) {
            log.wrapDetached("share key", log => this._shareNewRoomKey(megolmResult.roomKeyMessage, hsApi, log));
        }
        return {
            type: ENCRYPTED_TYPE,
            content: megolmResult.content
        };
    }

    needsToShareKeys(memberChanges) {
        for (const m of memberChanges.values()) {
            if (m.hasJoined) {
                return true;
            }
        }
        return false;
    }

    async _shareNewRoomKey(roomKeyMessage, hsApi, log) {
        let writeOpTxn = await this._storage.readWriteTxn([this._storage.storeNames.operations]);
        let operation;
        try {
            operation = this._writeRoomKeyShareOperation(roomKeyMessage, null, writeOpTxn);
        } catch (err) {
            writeOpTxn.abort();
            throw err;
        }
        // TODO: at this point we have the room key stored, and the rest is sort of optional
        // it would be nice if we could signal SendQueue that any error from here on is non-fatal and
        // return the encrypted payload.
        await this._processShareRoomKeyOperation(operation, hsApi, log);
    }

    async _addShareRoomKeyOperationForNewMembers(memberChangesArray, txn, log) {
        const userIds = memberChangesArray.filter(m => m.hasJoined).map(m => m.userId);
        const roomKeyMessage = await this._megolmEncryption.createRoomKeyMessage(
            this._room.id, txn);
        if (roomKeyMessage) {
            log.log({
                l: "share key for new members", userIds,
                id: roomKeyMessage.session_id,
                chain_index: roomKeyMessage.chain_index
            });
            this._writeRoomKeyShareOperation(roomKeyMessage, userIds, txn);
            return true;
        }
        return false;
    }

    async flushPendingRoomKeyShares(hsApi, operations, log) {
        // this has to be reentrant as it can be called from Room.start while still running
        if (this._isFlushingRoomKeyShares) {
            return;
        }
        this._isFlushingRoomKeyShares = true;
        try {
            if (!operations) {
                const txn = await this._storage.readTxn([this._storage.storeNames.operations]);
                operations = await txn.operations.getAllByTypeAndScope("share_room_key", this._room.id);
            }
            for (const operation of operations) {
                // just to be sure
                if (operation.type !== "share_room_key") {
                    continue;
                }
                await log.wrap("operation", log => this._processShareRoomKeyOperation(operation, hsApi, log));
            }
        } finally {
            this._isFlushingRoomKeyShares = false;
        }
    }

    _writeRoomKeyShareOperation(roomKeyMessage, userIds, txn) {
        const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString();
        const operation = {
            id,
            type: "share_room_key",
            scope: this._room.id,
            userIds,
            roomKeyMessage,
        };
        txn.operations.add(operation);
        return operation;
    }

    async _processShareRoomKeyOperation(operation, hsApi, log) {
        log.set("id", operation.id);

        await this._deviceTracker.trackRoom(this._room, log);
        let devices;
        if (operation.userIds === null) {
            devices = await this._deviceTracker.devicesForTrackedRoom(this._room.id, hsApi, log);
            const userIds = Array.from(devices.reduce((set, device) => set.add(device.userId), new Set()));
            operation.userIds = userIds;
            await this._updateOperationsStore(operations => operations.update(operation));
        } else {
            devices = await this._deviceTracker.devicesForRoomMembers(this._room.id, operation.userIds, hsApi, log);
        }
        
        const messages = await log.wrap("olm encrypt", log => this._olmEncryption.encrypt(
            "m.room_key", operation.roomKeyMessage, devices, hsApi, log));
        const missingDevices = devices.filter(d => !messages.some(m => m.device === d));
        await log.wrap("send", log => this._sendMessagesToDevices(ENCRYPTED_TYPE, messages, hsApi, log));
        if (missingDevices.length) {
            await log.wrap("missingDevices", async log => {
                log.set("devices", missingDevices.map(d => d.deviceId));
                const unsentUserIds = operation.userIds.filter(userId => missingDevices.some(d => d.userId === userId));
                log.set("unsentUserIds", unsentUserIds);
                operation.userIds = unsentUserIds;
                // first remove the users that we've sent the keys already from the operation,
                // so if anything fails, we don't send them again
                await this._updateOperationsStore(operations => operations.update(operation));
                // now, let the devices we could not claim their key
                const withheldMessage = this._megolmEncryption.createWithheldMessage(operation.roomKeyMessage, "m.no_olm", "OTKs exhausted");
                await this._sendSharedMessageToDevices("org.matrix.room_key.withheld", withheldMessage, missingDevices, hsApi, log);
            });
        }
        await this._updateOperationsStore(operations => operations.remove(operation.id));
    }

    async _updateOperationsStore(callback) {
        const writeTxn = await this._storage.readWriteTxn([this._storage.storeNames.operations]);
        try {
            callback(writeTxn.operations);
        } catch (err) {
            writeTxn.abort();
            throw err;
        }
        await writeTxn.complete();
    }

    async _sendSharedMessageToDevices(type, message, devices, hsApi, log) {
        const devicesByUser = groupBy(devices, device => device.userId);
        const payload = {
            messages: Array.from(devicesByUser.entries()).reduce((userMap, [userId, devices]) => {
                userMap[userId] = devices.reduce((deviceMap, device) => {
                    deviceMap[device.deviceId] = message;
                    return deviceMap;
                }, {});
                return userMap;
            }, {})
        };
        const txnId = makeTxnId();
        await hsApi.sendToDevice(type, payload, txnId, {log}).response();
    }

    async _sendMessagesToDevices(type, messages, hsApi, log) {
        log.set("messages", messages.length);
        const messagesByUser = groupBy(messages, message => message.device.userId);
        const payload = {
            messages: Array.from(messagesByUser.entries()).reduce((userMap, [userId, messages]) => {
                userMap[userId] = messages.reduce((deviceMap, message) => {
                    deviceMap[message.device.deviceId] = message.content;
                    return deviceMap;
                }, {});
                return userMap;
            }, {})
        };
        const txnId = makeTxnId();
        await hsApi.sendToDevice(type, payload, txnId, {log}).response();
    }

    filterUndecryptedEventEntriesForKeys(entries, keys) {
        return entries.filter(entry => {
            if (entry.isEncrypted && !entry.isDecrypted) {
                const {event} = entry;
                if (event) {
                    const senderKey = event.content?.["sender_key"];
                    const sessionId = event.content?.["session_id"];
                    return keys.some(key => senderKey === key.senderKey && sessionId === key.sessionId);
                }
            }
            return false;
        });
    }

    dispose() {
        this._disposed = true;
        this._megolmBackfillCache.dispose();
        this._megolmSyncCache.dispose();
    }
}

/**
 * wrappers around megolm decryption classes to be able to post-process
 * the decryption results before turning them
 */
class DecryptionPreparation {
    constructor(megolmDecryptionPreparation, extraErrors, source, roomEncryption, events) {
        this._megolmDecryptionPreparation = megolmDecryptionPreparation;
        this._extraErrors = extraErrors;
        this._source = source;
        this._roomEncryption = roomEncryption;
        this._events = events;
    }

    async decrypt() {
        return new DecryptionChanges(
            await this._megolmDecryptionPreparation.decrypt(),
            this._extraErrors,
            this._source,
            this._roomEncryption,
            this._events);
    }

    dispose() {
        this._megolmDecryptionPreparation.dispose();
    }
}

class DecryptionChanges {
    constructor(megolmDecryptionChanges, extraErrors, source, roomEncryption, events) {
        this._megolmDecryptionChanges = megolmDecryptionChanges;
        this._extraErrors = extraErrors;
        this._source = source;
        this._roomEncryption = roomEncryption;
        this._events = events;
    }

    async write(txn, log) {
        const {results, errors} = await this._megolmDecryptionChanges.write(txn);
        mergeMap(this._extraErrors, errors);
        await this._roomEncryption._processDecryptionResults(this._events, results, errors, this._source, txn, log);
        return new BatchDecryptionResult(results, errors, this._roomEncryption);
    }
}

class BatchDecryptionResult {
    constructor(results, errors, roomEncryption) {
        this.results = results;
        this.errors = errors;
        this._roomEncryption = roomEncryption;
    }

    applyToEntries(entries) {
        for (const entry of entries) {
            const result = this.results.get(entry.id);
            if (result) {
                entry.setDecryptionResult(result);
            } else {
                const error = this.errors.get(entry.id);
                if (error) {
                    entry.setDecryptionError(error);
                }
            }
        }
    }

    verifySenders(txn) {
        return Promise.all(Array.from(this.results.values()).map(result => {
            return this._roomEncryption._verifyDecryptionResult(result, txn);
        }));
    }
}
