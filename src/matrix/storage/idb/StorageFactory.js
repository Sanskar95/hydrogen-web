/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>

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

import {Storage} from "./Storage.js";
import { openDatabase, reqAsPromise } from "./utils.js";
import { exportSession, importSession } from "./export.js";
import { schema } from "./schema.js";
import { detectWebkitEarlyCloseTxnBug } from "./quirks.js";

const sessionName = sessionId => `hydrogen_session_${sessionId}`;
const openDatabaseWithSessionId = sessionId => openDatabase(sessionName(sessionId), createStores, schema.length);

async function requestPersistedStorage() {
    if (navigator?.storage?.persist) {
        return await navigator.storage.persist();
    } else if (document.requestStorageAccess) {
        try {
            await document.requestStorageAccess();
            return true;
        } catch (err) {
            return false;
        }
    } else {
        return false;
    }
}

export class StorageFactory {
    constructor(serviceWorkerHandler) {
        this._serviceWorkerHandler = serviceWorkerHandler;
    }

    async create(sessionId) {
        await this._serviceWorkerHandler?.preventConcurrentSessionAccess(sessionId);
        requestPersistedStorage().then(persisted => {
            // Firefox lies here though, and returns true even if the user denied the request
            if (!persisted) {
                console.warn("no persisted storage, database can be evicted by browser");
            }
        });

        const hasWebkitEarlyCloseTxnBug = await detectWebkitEarlyCloseTxnBug();
        const db = await openDatabaseWithSessionId(sessionId);
        return new Storage(db, hasWebkitEarlyCloseTxnBug);
    }

    delete(sessionId) {
        const databaseName = sessionName(sessionId);
        const req = indexedDB.deleteDatabase(databaseName);
        return reqAsPromise(req);
    }

    async export(sessionId) {
        const db = await openDatabaseWithSessionId(sessionId);
        return await exportSession(db);
    }

    async import(sessionId, data) {
        const db = await openDatabaseWithSessionId(sessionId);
        return await importSession(db, data);
    }
}

async function createStores(db, txn, oldVersion, version) {
    const startIdx = oldVersion || 0;

    for(let i = startIdx; i < version; ++i) {
        await schema[i](db, txn);
    }
}
