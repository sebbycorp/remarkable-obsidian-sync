# reMarkable Cloud Sync for Obsidian

An Obsidian plugin that syncs your reMarkable tablet notebooks and annotations directly to your Obsidian vault via the Cloud API.

## Features

- **Cloud-based sync** - No SSH or USB required, syncs via reMarkable Cloud
- **Full notebook support** - Syncs handwritten notes as SVG images
- **Text extraction** - Extracts typed text from documents
- **Folder structure** - Preserves your reMarkable folder hierarchy
- **Selective sync** - Browse and sync individual documents
- **Auto-sync** - Optionally sync at regular intervals
- **Smart caching** - Only syncs documents that have changed

## Installation

### From Source

1. Clone this repository into your vault's `.obsidian/plugins/` folder:
   ```bash
   cd /path/to/your/vault/.obsidian/plugins/
   git clone https://github.com/yourusername/remarkable-obsidian-sync.git
   ```

2. Install dependencies:
   ```bash
   cd remarkable-obsidian-sync
   npm install
   ```

3. Build the plugin:
   ```bash
   npm run build
   ```

4. Enable the plugin in Obsidian Settings → Community Plugins

### From Releases

1. Download the latest release from the Releases page
2. Extract `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/remarkable-cloud-sync/`
3. Enable the plugin in Obsidian Settings → Community Plugins

## Setup

### Connecting Your reMarkable

1. Open the plugin settings in Obsidian
2. Click "Connect" to start the connection process
3. Go to [my.remarkable.com](https://my.remarkable.com) and sign in
4. Generate a one-time connection code
5. Enter the 8-character code in the plugin
6. Click "Connect" - you're now synced!

## Usage

### Syncing All Documents

- Click the tablet icon in the left ribbon, or
- Use the command palette: "Sync reMarkable notebooks"

### Browsing and Selective Sync

1. Use command palette: "Browse reMarkable files"
2. Navigate through your folders
3. Click "Sync" on individual documents

### Auto-Sync

Enable auto-sync in settings to automatically sync at regular intervals (5-120 minutes).

## Output Format

Each synced notebook creates:

- **Markdown file** (`notebook-name.md`) - Contains frontmatter with metadata, page headers, extracted text, and embedded images
- **SVG images** (`assets/`) - One SVG per page with handwritten content

Example output:
```markdown
---
title: "My Notebook"
remarkable_id: "abc123..."
last_modified: "2024-01-15T10:30:00Z"
page_count: 5
---

# My Notebook

## Page 1

![[abc123-page-1.svg]]

## Page 2

This is some typed text from the document.

![[abc123-page-2.svg]]
```

## Settings

| Setting | Description |
|---------|-------------|
| **Sync folder** | Where to save synced notes (default: `reMarkable`) |
| **Auto sync** | Enable automatic syncing |
| **Sync interval** | How often to auto-sync (5-120 minutes) |
| **Include images** | Save SVG images of handwritten notes |
| **Crop images** | Crop images to content area (removes whitespace) |

## Technical Details

### API

This plugin uses the reMarkable Cloud API, which was reverse-engineered by the community. The API:

- Authenticates via device registration
- Uses bearer tokens for requests
- Stores documents as ZIP archives containing `.rm` files

### File Format

reMarkable uses a proprietary binary format (`.rm` files) for storing handwritten content. This plugin includes a parser for:

- **v6 format** (firmware 3.0+) - Current format
- **v3-v5 formats** - Older firmware versions

### Dependencies

- [JSZip](https://stuk.github.io/jszip/) - For extracting document archives
- Obsidian API - For vault integration

## Limitations

- **Read-only** - This plugin only syncs FROM reMarkable TO Obsidian
- **Handwriting recognition** - No OCR; handwritten notes are saved as images
- **PDF annotations** - Currently syncs notebooks only; PDF annotation sync is planned
- **reMarkable Paper Pro** - Not yet tested

## Troubleshooting

### "Connection failed"

- Ensure you're using a fresh code from my.remarkable.com
- Codes expire after 5 minutes
- Each code can only be used once

### "Failed to sync document"

- Check your internet connection
- Try disconnecting and reconnecting in settings
- Check the console (Ctrl+Shift+I) for detailed error messages

### Images not displaying

- Ensure "Include images" is enabled in settings
- Check that the `assets` folder was created in your sync folder

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Credits

This plugin builds on the work of:

- [rmapi](https://github.com/juruen/rmapi) - Go implementation of the Cloud API
- [rmscene](https://github.com/ricklupton/rmscene) - Python .rm file parser
- [remarkable_file_format](https://github.com/YakBarber/remarkable_file_format) - v6 format specification
- [Scrybble](https://scrybble.ink/) - Inspiration for the plugin architecture

## License

MIT License - see [LICENSE](LICENSE) for details.

## Disclaimer

This is an unofficial plugin and is not affiliated with reMarkable AS. Use at your own risk.
