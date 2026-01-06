/**
 * reMarkable Cloud API Client
 *
 * Implements authentication and file sync with the reMarkable Cloud.
 * Based on reverse-engineered API documentation.
 */

import { requestUrl, RequestUrlResponse } from 'obsidian';

// API Endpoints
const AUTH_HOST = 'https://webapp-prod.cloud.remarkable.engineering';
const SYNC_HOST = 'https://internal.cloud.remarkable.com';
const DISCOVERY_HOST = 'https://service-manager-production-dot-remarkable-production.appspot.com';

export interface RemarkableItem {
    id: string;
    hash: string;
    type: 'DocumentType' | 'CollectionType';
    visibleName: string;
    lastModified: string;
    parent: string;
    pinned: boolean;
    version: number;
}

export interface DocumentMetadata {
    visibleName: string;
    parent: string;
    lastModified: string;
    lastOpened: string;
    version: number;
    pinned: boolean;
    type: 'DocumentType' | 'CollectionType';
}

export interface SyncState {
    generation: number;
    hash: string;
}

export class RemarkableClient {
    private deviceToken: string | null = null;
    private userToken: string | null = null;
    private syncHost: string = SYNC_HOST;

    constructor(deviceToken?: string) {
        if (deviceToken) {
            this.deviceToken = deviceToken;
        }
    }

    /**
     * Register a new device using a one-time code from my.remarkable.com
     * @param code 8-character alphanumeric code
     * @returns Device token for future authentication
     */
    async register(code: string): Promise<string> {
        const deviceId = this.generateDeviceId();

        const response = await requestUrl({
            url: `${AUTH_HOST}/token/json/2/device/new`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                code: code,
                deviceDesc: 'desktop-windows',
                deviceID: deviceId,
            }),
        });

        if (response.status !== 200) {
            throw new Error(`Registration failed: ${response.status} - ${response.text}`);
        }

        this.deviceToken = response.text;
        return this.deviceToken;
    }

    /**
     * Refresh the user token using the device token
     * Must be called before making API requests
     */
    async refreshToken(): Promise<void> {
        if (!this.deviceToken) {
            throw new Error('No device token. Please register first.');
        }

        const response = await requestUrl({
            url: `${AUTH_HOST}/token/json/2/user/new`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.deviceToken}`,
            },
        });

        if (response.status !== 200) {
            throw new Error(`Token refresh failed: ${response.status}`);
        }

        this.userToken = response.text;

        // Discover the sync host
        await this.discoverSyncHost();
    }

    /**
     * Discover the document storage host
     */
    private async discoverSyncHost(): Promise<void> {
        try {
            const response = await requestUrl({
                url: `${DISCOVERY_HOST}/service/json/1/document-storage?environment=production&apiVer=2`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.userToken}`,
                },
            });

            if (response.status === 200) {
                const data = response.json;
                if (data.Host) {
                    this.syncHost = `https://${data.Host}`;
                }
            }
        } catch {
            // Use default sync host if discovery fails
            console.log('Using default sync host');
        }
    }

    /**
     * Get the current sync state (root hash and generation)
     */
    async getSyncState(): Promise<SyncState> {
        await this.ensureAuthenticated();

        const response = await requestUrl({
            url: `${this.syncHost}/sync/v2/root`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.userToken}`,
            },
        });

        if (response.status !== 200) {
            throw new Error(`Failed to get sync state: ${response.status}`);
        }

        return response.json;
    }

    /**
     * List all items (documents and folders) in the cloud
     */
    async listItems(): Promise<RemarkableItem[]> {
        await this.ensureAuthenticated();

        const response = await requestUrl({
            url: `${this.syncHost}/document-storage/json/2/docs`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.userToken}`,
            },
        });

        if (response.status !== 200) {
            throw new Error(`Failed to list items: ${response.status}`);
        }

        return response.json;
    }

    /**
     * Download a document as a ZIP file containing .rm files and metadata
     * @param id Document ID
     * @returns ArrayBuffer containing the ZIP file
     */
    async downloadDocument(id: string): Promise<ArrayBuffer> {
        await this.ensureAuthenticated();

        // First, get the blob URL
        const response = await requestUrl({
            url: `${this.syncHost}/document-storage/json/2/docs?doc=${id}&withBlob=true`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.userToken}`,
            },
        });

        if (response.status !== 200) {
            throw new Error(`Failed to get document info: ${response.status}`);
        }

        const docs = response.json;
        if (!docs || docs.length === 0 || !docs[0].BlobURLGet) {
            throw new Error('No blob URL found for document');
        }

        // Download the actual ZIP file
        const blobResponse = await requestUrl({
            url: docs[0].BlobURLGet,
            method: 'GET',
        });

        if (blobResponse.status !== 200) {
            throw new Error(`Failed to download document: ${blobResponse.status}`);
        }

        return blobResponse.arrayBuffer;
    }

    /**
     * Download document using the new sync v3 protocol
     * @param hash Document hash
     */
    async downloadByHash(hash: string): Promise<ArrayBuffer> {
        await this.ensureAuthenticated();

        const response = await requestUrl({
            url: `${this.syncHost}/sync/v3/files/${hash}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.userToken}`,
            },
        });

        if (response.status !== 200) {
            throw new Error(`Failed to download by hash: ${response.status}`);
        }

        return response.arrayBuffer;
    }

    /**
     * Get metadata for a specific document
     */
    async getDocumentMetadata(id: string): Promise<DocumentMetadata | null> {
        await this.ensureAuthenticated();

        const response = await requestUrl({
            url: `${this.syncHost}/document-storage/json/2/docs?doc=${id}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.userToken}`,
            },
        });

        if (response.status !== 200) {
            return null;
        }

        const docs = response.json;
        if (!docs || docs.length === 0) {
            return null;
        }

        return docs[0];
    }

    /**
     * Build a tree structure from flat item list
     */
    buildTree(items: RemarkableItem[]): Map<string, RemarkableItem[]> {
        const tree = new Map<string, RemarkableItem[]>();

        for (const item of items) {
            const parent = item.parent || 'root';
            if (!tree.has(parent)) {
                tree.set(parent, []);
            }
            tree.get(parent)!.push(item);
        }

        return tree;
    }

    /**
     * Get documents only (no folders)
     */
    async getDocuments(): Promise<RemarkableItem[]> {
        const items = await this.listItems();
        return items.filter(item => item.type === 'DocumentType');
    }

    /**
     * Get folders only
     */
    async getFolders(): Promise<RemarkableItem[]> {
        const items = await this.listItems();
        return items.filter(item => item.type === 'CollectionType');
    }

    /**
     * Get the full path of an item
     */
    getItemPath(item: RemarkableItem, items: RemarkableItem[]): string {
        const parts: string[] = [item.visibleName];
        let current = item;

        while (current.parent && current.parent !== '' && current.parent !== 'trash') {
            const parent = items.find(i => i.id === current.parent);
            if (!parent) break;
            parts.unshift(parent.visibleName);
            current = parent;
        }

        return parts.join('/');
    }

    private async ensureAuthenticated(): Promise<void> {
        if (!this.userToken) {
            if (!this.deviceToken) {
                throw new Error('Not authenticated. Please register first.');
            }
            await this.refreshToken();
        }
    }

    private generateDeviceId(): string {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 8; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    /**
     * Check if the client is authenticated
     */
    isAuthenticated(): boolean {
        return this.deviceToken !== null;
    }

    /**
     * Get the device token for storage
     */
    getDeviceToken(): string | null {
        return this.deviceToken;
    }

    /**
     * Set the device token (for loading from storage)
     */
    setDeviceToken(token: string): void {
        this.deviceToken = token;
    }
}
