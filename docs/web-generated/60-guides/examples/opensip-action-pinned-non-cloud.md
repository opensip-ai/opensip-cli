```yaml
name: OpenSIP
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write
  security-events: write

jobs:
  opensip:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Pin both the action ref and the npm package version for regulated CI.
      # Replace the example SHA with a reviewed opensip-ai/opensip-cli commit.
      - uses: opensip-ai/opensip-cli@0123456789abcdef0123456789abcdef01234567
        id: opensip
        with:
          version: 0.2.4
          suite: audit
          changed: true
          annotations: true
          comment: false
          sarif: true
          fail-on: new-errors

      - uses: github/codeql-action/upload-sarif@v4
        if: always() && steps.opensip.outputs.sarif != ''
        with:
          sarif_file: ${{ steps.opensip.outputs.sarif }}
          category: opensip-cli
```
