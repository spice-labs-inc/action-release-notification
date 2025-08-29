# Spice Labs Slack Notifications Action

Standardized GitHub Action for sending release, deployment, and staging notifications to Slack with automatic GitHub→Slack username mapping.

## Setup

### 1. Set org-wide secrets in GitHub

- **`SLACK_BOT_TOKEN`** - Your Slack bot token (starts with `xoxb-`)
- **`GITHUB_SLACK_USERNAME_MAPPING`** - JSON mapping:
  ```json
  {
    "github_username": "U1234567890",
    "another_user": "U0987654321"
  }
  ```

### 2. Use in workflows

#### Release notifications
```yaml
- uses: spice-labs-inc/action-release-notification@v1
  with:
    type: release
    slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
    channel: "#releases"
    release-tag: ${{ github.event.release.tag_name }}
    release-name: ${{ github.event.release.name }}
    release-notes: ${{ github.event.release.body }}
```

#### Deployment success/failure
```yaml
- uses: spice-labs-inc/action-release-notification@v1
  with:
    type: deployment-success  # or deployment-failure
    slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
    channel: "#deployments"
    workflow-name: ${{ github.workflow }}
    environment: production
```

#### Staging updates
```yaml
- uses: spice-labs-inc/action-release-notification@v1
  with:
    type: staging
    slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
    channel: "#staging"
    commit-message: ${{ github.event.head_commit.message }}
    staging-url: "https://staging.yourdomain.com"
```

See [`examples/`](./examples/) for complete workflow files.