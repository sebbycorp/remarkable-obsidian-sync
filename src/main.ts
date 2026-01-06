/**
 * reMarkable Cloud Sync Plugin for Obsidian
 *
 * Syncs notebooks and annotations from reMarkable tablets to Obsidian
 * via the Cloud API.
 */

import {
    App,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
    normalizePath,
} from 'obsidian';
import { RemarkableClient, RemarkableItem } from './api/remarkable-client';
import { processDocumentZip, documentToMarkdown, extractSvgFiles, DocumentContent } from './document-processor';

interface RemarkableCloudSyncSettings {
    deviceToken: string;
    syncFolder: string;
    autoSync: boolean;
    syncInterval: number; // minutes
    includeImages: boolean;
    cropImages: boolean;
    lastSyncTime: number;
    syncedDocuments: Record<string, { hash: string; lastModified: string }>;
}

const DEFAULT_SETTINGS: RemarkableCloudSyncSettings = {
    deviceToken: '',
    syncFolder: 'reMarkable',
    autoSync: false,
    syncInterval: 30,
    includeImages: true,
    cropImages: true,
    lastSyncTime: 0,
    syncedDocuments: {},
};

export default class RemarkableCloudSyncPlugin extends Plugin {
    settings: RemarkableCloudSyncSettings = DEFAULT_SETTINGS;
    client: RemarkableClient | null = null;
    syncIntervalId: number | null = null;

    async onload() {
        await this.loadSettings();

        // Initialize client if we have a device token
        if (this.settings.deviceToken) {
            this.client = new RemarkableClient(this.settings.deviceToken);
        }

        // Add ribbon icon
        this.addRibbonIcon('tablet', 'reMarkable Sync', async () => {
            if (!this.client?.isAuthenticated()) {
                new Notice('Please connect your reMarkable tablet first');
                this.openSettings();
                return;
            }
            await this.syncDocuments();
        });

        // Add commands
        this.addCommand({
            id: 'sync-remarkable',
            name: 'Sync reMarkable notebooks',
            callback: async () => {
                if (!this.client?.isAuthenticated()) {
                    new Notice('Please connect your reMarkable tablet first');
                    return;
                }
                await this.syncDocuments();
            },
        });

        this.addCommand({
            id: 'browse-remarkable',
            name: 'Browse reMarkable files',
            callback: async () => {
                if (!this.client?.isAuthenticated()) {
                    new Notice('Please connect your reMarkable tablet first');
                    return;
                }
                new FileBrowserModal(this.app, this, this.client).open();
            },
        });

        this.addCommand({
            id: 'connect-remarkable',
            name: 'Connect reMarkable tablet',
            callback: () => {
                new ConnectModal(this.app, this).open();
            },
        });

        // Add settings tab
        this.addSettingTab(new RemarkableCloudSyncSettingTab(this.app, this));

        // Start auto-sync if enabled
        this.setupAutoSync();
    }

    onunload() {
        if (this.syncIntervalId !== null) {
            window.clearInterval(this.syncIntervalId);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    openSettings() {
        // Open plugin settings
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById(this.manifest.id);
    }

    setupAutoSync() {
        // Clear existing interval
        if (this.syncIntervalId !== null) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }

        // Set up new interval if auto-sync is enabled
        if (this.settings.autoSync && this.client?.isAuthenticated()) {
            const intervalMs = this.settings.syncInterval * 60 * 1000;
            this.syncIntervalId = window.setInterval(() => {
                this.syncDocuments(true);
            }, intervalMs);
        }
    }

    async syncDocuments(silent: boolean = false) {
        if (!this.client) {
            if (!silent) new Notice('Not connected to reMarkable');
            return;
        }

        try {
            if (!silent) new Notice('Syncing with reMarkable...');

            // Refresh token
            await this.client.refreshToken();

            // Get all documents
            const items = await this.client.listItems();
            const documents = items.filter(item => item.type === 'DocumentType');

            // Ensure sync folder exists
            await this.ensureFolderExists(this.settings.syncFolder);

            let syncedCount = 0;
            let errorCount = 0;

            for (const doc of documents) {
                try {
                    // Check if document needs syncing
                    const cached = this.settings.syncedDocuments[doc.id];
                    if (cached && cached.hash === doc.hash) {
                        continue; // Already up to date
                    }

                    // Get document path
                    const folderPath = this.getDocumentFolderPath(doc, items);
                    await this.ensureFolderExists(folderPath);

                    // Download and process document
                    const zipData = await this.client.downloadDocument(doc.id);
                    const content = await processDocumentZip(zipData, doc.id);

                    // Save document
                    await this.saveDocument(content, folderPath);

                    // Update cache
                    this.settings.syncedDocuments[doc.id] = {
                        hash: doc.hash,
                        lastModified: doc.lastModified,
                    };

                    syncedCount++;
                } catch (error) {
                    console.error(`Failed to sync document ${doc.visibleName}:`, error);
                    errorCount++;
                }
            }

            // Save settings with updated cache
            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();

            if (!silent) {
                if (errorCount > 0) {
                    new Notice(`Synced ${syncedCount} documents with ${errorCount} errors`);
                } else if (syncedCount > 0) {
                    new Notice(`Synced ${syncedCount} documents`);
                } else {
                    new Notice('All documents up to date');
                }
            }
        } catch (error) {
            console.error('Sync failed:', error);
            if (!silent) new Notice(`Sync failed: ${error}`);
        }
    }

    getDocumentFolderPath(doc: RemarkableItem, allItems: RemarkableItem[]): string {
        const pathParts = [this.settings.syncFolder];
        let current = doc;

        // Build path from parent chain
        const parents: string[] = [];
        while (current.parent && current.parent !== '' && current.parent !== 'trash') {
            const parent = allItems.find(i => i.id === current.parent);
            if (!parent) break;
            parents.unshift(parent.visibleName);
            current = parent;
        }

        pathParts.push(...parents);
        return normalizePath(pathParts.join('/'));
    }

    async ensureFolderExists(path: string): Promise<TFolder> {
        const normalizedPath = normalizePath(path);
        let folder = this.app.vault.getAbstractFileByPath(normalizedPath);

        if (folder instanceof TFolder) {
            return folder;
        }

        // Create folder and any missing parents
        await this.app.vault.createFolder(normalizedPath);
        return this.app.vault.getAbstractFileByPath(normalizedPath) as TFolder;
    }

    async saveDocument(content: DocumentContent, folderPath: string): Promise<void> {
        const basePath = normalizePath(`${folderPath}/${content.name}`);

        // Save markdown file
        const mdPath = `${basePath}.md`;
        const markdown = documentToMarkdown(content, this.settings.includeImages);

        const existingFile = this.app.vault.getAbstractFileByPath(mdPath);
        if (existingFile instanceof TFile) {
            await this.app.vault.modify(existingFile, markdown);
        } else {
            await this.app.vault.create(mdPath, markdown);
        }

        // Save SVG files if enabled
        if (this.settings.includeImages) {
            const svgFiles = extractSvgFiles(content, this.settings.cropImages);

            // Create assets folder if needed
            const assetsPath = normalizePath(`${folderPath}/assets`);
            await this.ensureFolderExists(assetsPath);

            for (const [fileName, svgContent] of svgFiles) {
                const svgPath = normalizePath(`${assetsPath}/${fileName}`);
                const existingSvg = this.app.vault.getAbstractFileByPath(svgPath);

                if (existingSvg instanceof TFile) {
                    await this.app.vault.modify(existingSvg, svgContent);
                } else {
                    await this.app.vault.create(svgPath, svgContent);
                }
            }
        }
    }

    async syncSingleDocument(doc: RemarkableItem, items: RemarkableItem[]): Promise<void> {
        if (!this.client) {
            throw new Error('Not connected');
        }

        new Notice(`Syncing "${doc.visibleName}"...`);

        const folderPath = this.getDocumentFolderPath(doc, items);
        await this.ensureFolderExists(folderPath);

        const zipData = await this.client.downloadDocument(doc.id);
        const content = await processDocumentZip(zipData, doc.id);

        await this.saveDocument(content, folderPath);

        // Update cache
        this.settings.syncedDocuments[doc.id] = {
            hash: doc.hash,
            lastModified: doc.lastModified,
        };
        await this.saveSettings();

        new Notice(`Synced "${doc.visibleName}"`);
    }
}

/**
 * Connection Modal for initial device registration
 */
class ConnectModal extends Modal {
    plugin: RemarkableCloudSyncPlugin;
    codeInput: HTMLInputElement | null = null;

    constructor(app: App, plugin: RemarkableCloudSyncPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Connect reMarkable Tablet' });

        contentEl.createEl('p', {
            text: 'To connect your reMarkable tablet, you need to get a one-time code from the reMarkable website.',
        });

        contentEl.createEl('ol', {}, ol => {
            ol.createEl('li', { text: 'Go to my.remarkable.com' });
            ol.createEl('li', { text: 'Sign in to your account' });
            ol.createEl('li', { text: 'Go to "Connect" or generate a new device code' });
            ol.createEl('li', { text: 'Enter the 8-character code below' });
        });

        const inputContainer = contentEl.createDiv({ cls: 'remarkable-code-input' });
        this.codeInput = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'Enter 8-character code',
            attr: {
                maxlength: '8',
                style: 'width: 200px; font-size: 18px; text-align: center; letter-spacing: 2px;',
            },
        });

        const buttonContainer = contentEl.createDiv({ cls: 'remarkable-buttons' });
        buttonContainer.style.marginTop = '20px';
        buttonContainer.style.textAlign = 'right';

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => this.close();

        const connectBtn = buttonContainer.createEl('button', {
            text: 'Connect',
            cls: 'mod-cta',
        });
        connectBtn.style.marginLeft = '10px';
        connectBtn.onclick = () => this.connect();
    }

    async connect() {
        const code = this.codeInput?.value?.trim().toLowerCase();

        if (!code || code.length !== 8) {
            new Notice('Please enter a valid 8-character code');
            return;
        }

        try {
            new Notice('Connecting to reMarkable...');

            const client = new RemarkableClient();
            const deviceToken = await client.register(code);

            // Save token
            this.plugin.settings.deviceToken = deviceToken;
            await this.plugin.saveSettings();

            // Set up client
            this.plugin.client = client;
            this.plugin.setupAutoSync();

            new Notice('Successfully connected to reMarkable!');
            this.close();
        } catch (error) {
            console.error('Connection failed:', error);
            new Notice(`Connection failed: ${error}`);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * File Browser Modal
 */
class FileBrowserModal extends Modal {
    plugin: RemarkableCloudSyncPlugin;
    client: RemarkableClient;
    items: RemarkableItem[] = [];
    currentFolder: string = '';

    constructor(app: App, plugin: RemarkableCloudSyncPlugin, client: RemarkableClient) {
        super(app);
        this.plugin = plugin;
        this.client = client;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('remarkable-file-browser');

        contentEl.createEl('h2', { text: 'reMarkable Files' });

        const loadingEl = contentEl.createEl('p', { text: 'Loading files...' });

        try {
            await this.client.refreshToken();
            this.items = await this.client.listItems();
            loadingEl.remove();
            this.renderFileList(contentEl);
        } catch (error) {
            loadingEl.setText(`Failed to load files: ${error}`);
        }
    }

    renderFileList(container: HTMLElement) {
        // Navigation
        const navEl = container.createDiv({ cls: 'remarkable-nav' });

        if (this.currentFolder) {
            const backBtn = navEl.createEl('button', { text: '← Back' });
            backBtn.onclick = () => {
                const currentItem = this.items.find(i => i.id === this.currentFolder);
                this.currentFolder = currentItem?.parent || '';
                this.renderFileList(container);
            };
        }

        // Get items in current folder
        const folderItems = this.items.filter(item => {
            if (this.currentFolder === '') {
                return !item.parent || item.parent === '' || item.parent === 'trash';
            }
            return item.parent === this.currentFolder;
        }).filter(item => item.parent !== 'trash');

        // Sort: folders first, then by name
        folderItems.sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'CollectionType' ? -1 : 1;
            }
            return a.visibleName.localeCompare(b.visibleName);
        });

        // Remove old list if exists
        const oldList = container.querySelector('.remarkable-file-list');
        if (oldList) oldList.remove();

        // File list
        const listEl = container.createDiv({ cls: 'remarkable-file-list' });
        listEl.style.maxHeight = '400px';
        listEl.style.overflow = 'auto';

        if (folderItems.length === 0) {
            listEl.createEl('p', { text: 'No files in this folder', cls: 'remarkable-empty' });
            return;
        }

        for (const item of folderItems) {
            const itemEl = listEl.createDiv({ cls: 'remarkable-file-item' });
            itemEl.style.padding = '8px';
            itemEl.style.borderBottom = '1px solid var(--background-modifier-border)';
            itemEl.style.display = 'flex';
            itemEl.style.alignItems = 'center';
            itemEl.style.cursor = 'pointer';

            const icon = item.type === 'CollectionType' ? '📁' : '📄';
            itemEl.createSpan({ text: `${icon} ${item.visibleName}` });

            if (item.type === 'CollectionType') {
                itemEl.onclick = () => {
                    this.currentFolder = item.id;
                    this.renderFileList(container);
                };
            } else {
                // Document - add sync button
                const syncBtn = itemEl.createEl('button', {
                    text: 'Sync',
                    cls: 'remarkable-sync-btn',
                });
                syncBtn.style.marginLeft = 'auto';
                syncBtn.onclick = async (e) => {
                    e.stopPropagation();
                    try {
                        await this.plugin.syncSingleDocument(item, this.items);
                    } catch (error) {
                        new Notice(`Failed to sync: ${error}`);
                    }
                };

                // Check if already synced
                const cached = this.plugin.settings.syncedDocuments[item.id];
                if (cached && cached.hash === item.hash) {
                    const syncedLabel = itemEl.createSpan({
                        text: '✓',
                        cls: 'remarkable-synced',
                    });
                    syncedLabel.style.marginLeft = '10px';
                    syncedLabel.style.color = 'var(--text-success)';
                }
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Settings Tab
 */
class RemarkableCloudSyncSettingTab extends PluginSettingTab {
    plugin: RemarkableCloudSyncPlugin;

    constructor(app: App, plugin: RemarkableCloudSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'reMarkable Cloud Sync Settings' });

        // Connection status
        const statusEl = containerEl.createDiv({ cls: 'remarkable-status' });
        if (this.plugin.client?.isAuthenticated()) {
            statusEl.createEl('p', {
                text: '✓ Connected to reMarkable',
                cls: 'remarkable-connected',
            });
            statusEl.style.color = 'var(--text-success)';

            new Setting(containerEl)
                .setName('Disconnect')
                .setDesc('Remove the connection to your reMarkable tablet')
                .addButton(btn => {
                    btn.setButtonText('Disconnect')
                        .setWarning()
                        .onClick(async () => {
                            this.plugin.settings.deviceToken = '';
                            this.plugin.client = null;
                            await this.plugin.saveSettings();
                            this.display();
                        });
                });
        } else {
            statusEl.createEl('p', {
                text: '✗ Not connected',
                cls: 'remarkable-disconnected',
            });
            statusEl.style.color = 'var(--text-error)';

            new Setting(containerEl)
                .setName('Connect')
                .setDesc('Connect your reMarkable tablet using a one-time code')
                .addButton(btn => {
                    btn.setButtonText('Connect')
                        .setCta()
                        .onClick(() => {
                            new ConnectModal(this.app, this.plugin).open();
                        });
                });
        }

        containerEl.createEl('h3', { text: 'Sync Settings' });

        new Setting(containerEl)
            .setName('Sync folder')
            .setDesc('Folder in your vault where reMarkable notes will be saved')
            .addText(text => text
                .setPlaceholder('reMarkable')
                .setValue(this.plugin.settings.syncFolder)
                .onChange(async (value) => {
                    this.plugin.settings.syncFolder = value || 'reMarkable';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto sync')
            .setDesc('Automatically sync notebooks at regular intervals')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                    this.plugin.setupAutoSync();
                }));

        new Setting(containerEl)
            .setName('Sync interval')
            .setDesc('How often to sync (in minutes)')
            .addSlider(slider => slider
                .setLimits(5, 120, 5)
                .setValue(this.plugin.settings.syncInterval)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncInterval = value;
                    await this.plugin.saveSettings();
                    this.plugin.setupAutoSync();
                }));

        containerEl.createEl('h3', { text: 'Output Settings' });

        new Setting(containerEl)
            .setName('Include images')
            .setDesc('Save SVG images of your handwritten notes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeImages)
                .onChange(async (value) => {
                    this.plugin.settings.includeImages = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Crop images')
            .setDesc('Crop images to content area (removes empty space)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.cropImages)
                .onChange(async (value) => {
                    this.plugin.settings.cropImages = value;
                    await this.plugin.saveSettings();
                }));

        // Sync info
        if (this.plugin.settings.lastSyncTime > 0) {
            const lastSync = new Date(this.plugin.settings.lastSyncTime);
            containerEl.createEl('p', {
                text: `Last synced: ${lastSync.toLocaleString()}`,
                cls: 'setting-item-description',
            });
        }

        // Manual sync button
        if (this.plugin.client?.isAuthenticated()) {
            new Setting(containerEl)
                .setName('Sync now')
                .setDesc('Manually sync all notebooks')
                .addButton(btn => {
                    btn.setButtonText('Sync')
                        .setCta()
                        .onClick(() => {
                            this.plugin.syncDocuments();
                        });
                });

            new Setting(containerEl)
                .setName('Browse files')
                .setDesc('Browse and selectively sync files from your reMarkable')
                .addButton(btn => {
                    btn.setButtonText('Browse')
                        .onClick(() => {
                            new FileBrowserModal(this.app, this.plugin, this.plugin.client!).open();
                        });
                });
        }
    }
}
