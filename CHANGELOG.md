# Changelog

## Unreleased

### Added
- Upload progress UI for active uploads
- Cancel upload support from the web interface
- Resumable chunked uploads for large files
- Backend integration test for the chunked upload flow

### Changed
- Docker Compose now uses env-configured bind addresses for published ports
- Deployment now runs from the persistent server checkout
- Docker Compose project naming is pinned for consistent deployments
- Large file uploads now use chunk sessions instead of one long multipart request

### Fixed
- Home LAN access to the app was restricted so the app can be reached through the NetBird IP only
- Interrupted uploads no longer write directly to final filenames
- Partial `.part` files are cleaned up on failed or aborted uploads
- Retries after interrupted uploads no longer create misleading completed files
- Docker deployment conflicts caused by fixed container names were removed
