#!/bin/bash
#
# Initial server setup for local quicksave relay
# Supports both staging and production on the same server
#
# Safe to re-run: preserves existing deploy tokens and relay env files.
# Re-run after repo changes (e.g. app rename, new systemd env requirements) to
# refresh the unit files without rotating secrets.
#
# Usage: ssh root@your-server 'bash -s' < scripts/setup-server.sh
#
set -e

# Configuration - update these
DOMAIN="localhost"
GITHUB_REPO="ns-lhsiang/quicksave"

# Derived domains
STAGING_DOMAIN="staging.${DOMAIN}"
SIGNAL_DOMAIN="signal.${DOMAIN}"
SIGNAL_STAGING_DOMAIN="signal-staging.${DOMAIN}"

# Preserve existing deploy tokens across re-runs so we don't have to rotate the
# webhook secret every time the script is re-applied.
extract_token() {
    # Pull the current value of "X-Deploy-Token" for a given hook id from hooks.json.
    local hook_id="$1"
    local file="/opt/webhook/hooks.json"
    [ -f "$file" ] || return 1
    python3 - "$file" "$hook_id" <<'PY' 2>/dev/null || return 1
import json, sys
path, hook_id = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
for hook in data:
    if hook.get('id') == hook_id:
        rule = hook.get('trigger-rule', {}).get('match', {})
        if rule.get('parameter', {}).get('name') == 'X-Deploy-Token':
            print(rule.get('value', ''))
            sys.exit(0)
sys.exit(1)
PY
}

DEPLOY_TOKEN_PROD="$(extract_token deploy-production || true)"
DEPLOY_TOKEN_STAGING="$(extract_token deploy-staging || true)"
[ -z "$DEPLOY_TOKEN_PROD" ] && DEPLOY_TOKEN_PROD="$(openssl rand -hex 32)"
[ -z "$DEPLOY_TOKEN_STAGING" ] && DEPLOY_TOKEN_STAGING="$(openssl rand -hex 32)"

echo "==> Installing dependencies..."
apt update
apt install -y curl gnupg rsync

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list
apt update && apt install -y gh

# Webhook
apt install -y webhook

echo "==> Creating directory structure..."
mkdir -p /opt/quicksave/{production,staging}/apps/{pwa,relay}/dist
mkdir -p /opt/quicksave/scripts
mkdir -p /opt/webhook

echo "==> Setting up webhook..."
# Separate hooks for each environment - token determines environment, not headers
cat > /opt/webhook/hooks.json << EOF
[
  {
    "id": "deploy-staging",
    "execute-command": "/opt/quicksave/scripts/deploy.sh",
    "command-working-directory": "/opt/quicksave",
    "pass-environment-to-command": [
      { "envname": "DEPLOY_ENV", "source": "string", "name": "staging" },
      { "envname": "RUN_ID", "source": "header", "name": "X-Run-ID" }
    ],
    "trigger-rule": {
      "match": {
        "type": "value",
        "value": "${DEPLOY_TOKEN_STAGING}",
        "parameter": { "source": "header", "name": "X-Deploy-Token" }
      }
    }
  },
  {
    "id": "deploy-production",
    "execute-command": "/opt/quicksave/scripts/deploy.sh",
    "command-working-directory": "/opt/quicksave",
    "pass-environment-to-command": [
      { "envname": "DEPLOY_ENV", "source": "string", "name": "production" },
      { "envname": "RUN_ID", "source": "header", "name": "X-Run-ID" }
    ],
    "trigger-rule": {
      "match": {
        "type": "value",
        "value": "${DEPLOY_TOKEN_PROD}",
        "parameter": { "source": "header", "name": "X-Deploy-Token" }
      }
    }
  }
]
EOF

cat > /etc/systemd/system/webhook.service << 'EOF'
[Unit]
Description=Webhook listener
After=network.target

[Service]
EnvironmentFile=/opt/quicksave/.env
ExecStart=/usr/bin/webhook -hooks /opt/webhook/hooks.json -port 9000 -verbose
Restart=always

[Install]
WantedBy=multi-user.target
EOF

# Create placeholder env file
cat > /opt/quicksave/.env << 'EOF'
# GitHub token with repo scope - required for deploy script
# Get one at: https://github.com/settings/tokens
GH_TOKEN=your_github_token_here
EOF
chmod 600 /opt/quicksave/.env

echo "==> Setting up relay env files..."

# Per-environment relay env file. Systemd reads it via EnvironmentFile, so edits
# here take effect on the next `systemctl restart quicksave-signaling(-staging)`
# without re-running this script. Only write a stub if nothing is there yet so
# real VAPID keys survive re-runs.
for env_name in production staging; do
    env_file="/opt/quicksave/${env_name}/relay.env"
    if [ ! -f "$env_file" ]; then
        cat > "$env_file" << 'RELAY_ENV'
# Relay runtime env. Restart the service after editing:
#   systemctl restart quicksave-signaling           # production
#   systemctl restart quicksave-signaling-staging   # staging
#
# Web Push (VAPID). Leave blank to disable push delivery.
# Generate a key pair with: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@localhost
# Optional: where push subscriptions are persisted on disk.
# PUSH_STORE_PATH=/var/lib/quicksave/push-store.json
RELAY_ENV
        chmod 600 "$env_file"
        # nobody needs to read the env file at service start.
        chown nobody:nogroup "$env_file" 2>/dev/null || chown nobody "$env_file"
    fi
done

echo "==> Setting up signaling services..."

# Production signaling
cat > /etc/systemd/system/quicksave-signaling.service << 'EOF'
[Unit]
Description=Quicksave Signaling Server (Production)
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/quicksave/production
# Leading `-` so missing file doesn't block startup (push just stays disabled).
EnvironmentFile=-/opt/quicksave/production/relay.env
ExecStart=/usr/bin/node apps/relay/dist/bundle.cjs
Restart=always
Environment=NODE_ENV=production
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
EOF

# Staging signaling
cat > /etc/systemd/system/quicksave-signaling-staging.service << 'EOF'
[Unit]
Description=Quicksave Signaling Server (Staging)
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/quicksave/staging
EnvironmentFile=-/opt/quicksave/staging/relay.env
ExecStart=/usr/bin/node apps/relay/dist/bundle.cjs
Restart=always
Environment=NODE_ENV=staging
Environment=PORT=8081

[Install]
WantedBy=multi-user.target
EOF

echo "==> Creating deploy script..."
cat > /opt/quicksave/scripts/deploy.sh << 'DEPLOY_SCRIPT'
#!/bin/bash
set -e

REPO="${GITHUB_REPO:-KingYoung-Sumicom/quicksave}"
ENV="${DEPLOY_ENV:-staging}"
LOG="/var/log/quicksave-deploy.log"

# Validate environment
if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then
    echo "$(date): ERROR - Invalid environment: $ENV" >> "$LOG"
    exit 1
fi

DEPLOY_DIR="/opt/quicksave/${ENV}"
SERVICE_NAME="quicksave-signaling"
[[ "$ENV" == "staging" ]] && SERVICE_NAME="quicksave-signaling-staging"

# Determine which branch/workflow to pull from
BRANCH="stable"
[[ "$ENV" == "staging" ]] && BRANCH="staging"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$ENV]: $1" | tee -a "$LOG"
}

log "Deploy triggered"

# Check gh is authenticated
if ! gh auth status &>/dev/null; then
    log "ERROR - GitHub CLI not authenticated. Run: gh auth login"
    exit 1
fi

# Get latest successful run for the branch
RUN_ID=$(gh run list --repo "$REPO" --workflow deploy.yml --branch "$BRANCH" --status success --limit 1 --json databaseId -q '.[0].databaseId')

if [ -z "$RUN_ID" ]; then
    log "ERROR - No successful workflow runs found for branch $BRANCH"
    exit 1
fi

log "Downloading artifacts from run $RUN_ID (branch: $BRANCH)"

# Download artifacts to temp directory
rm -rf /tmp/quicksave-deploy
gh run download "$RUN_ID" --repo "$REPO" --name "dist-${ENV}" --dir /tmp/quicksave-deploy

# Verify download
if [ ! -d "/tmp/quicksave-deploy/pwa/dist" ]; then
    log "ERROR - PWA dist not found in artifacts"
    exit 1
fi

if [ ! -d "/tmp/quicksave-deploy/relay/dist" ]; then
    log "ERROR - Relay dist not found in artifacts"
    exit 1
fi

# Copy to environment directory
log "Syncing files to $DEPLOY_DIR..."
rsync -av --delete /tmp/quicksave-deploy/pwa/dist/ "${DEPLOY_DIR}/apps/pwa/dist/"
rsync -av --delete /tmp/quicksave-deploy/relay/dist/ "${DEPLOY_DIR}/apps/relay/dist/"

# Cleanup
rm -rf /tmp/quicksave-deploy

# Restart signaling server
log "Restarting $SERVICE_NAME..."
systemctl restart "$SERVICE_NAME"

log "Deploy complete (run $RUN_ID)"
DEPLOY_SCRIPT

chmod +x /opt/quicksave/scripts/deploy.sh

echo "==> Enabling services..."
systemctl daemon-reload
systemctl enable webhook quicksave-signaling quicksave-signaling-staging
systemctl start webhook

# If the relay services were already running before this re-run (e.g. we just
# refreshed the unit file's ExecStart path or added EnvironmentFile), kick them
# so the new unit takes effect. Safe no-op when they were stopped.
for svc in quicksave-signaling quicksave-signaling-staging; do
    if systemctl is-active --quiet "$svc"; then
        echo "==> Restarting $svc (picking up updated unit)..."
        systemctl restart "$svc"
    fi
done

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "Server IP: $(curl -s ifconfig.me)"
echo ""
echo "==> DNS Records needed:"
echo "   A  ${DOMAIN}                -> $(curl -s ifconfig.me)"
echo "   A  ${STAGING_DOMAIN}        -> $(curl -s ifconfig.me)"
echo "   A  ${SIGNAL_DOMAIN}         -> $(curl -s ifconfig.me)"
echo "   A  ${SIGNAL_STAGING_DOMAIN} -> $(curl -s ifconfig.me)"
echo ""
echo "==> GitHub Environments to create:"
echo ""
echo "   Environment: production"
echo "     Variable: DEPLOY_URL = https://${SIGNAL_DOMAIN}/hooks/deploy-production"
echo "     Variable: SIGNAL_URL = wss://${SIGNAL_DOMAIN}"
echo "     Secret:   DEPLOY_TOKEN = ${DEPLOY_TOKEN_PROD}"
echo ""
echo "   Environment: staging"
echo "     Variable: DEPLOY_URL = https://${SIGNAL_STAGING_DOMAIN}/hooks/deploy-staging"
echo "     Variable: SIGNAL_URL = wss://${SIGNAL_STAGING_DOMAIN}"
echo "     Secret:   DEPLOY_TOKEN = ${DEPLOY_TOKEN_STAGING}"
echo ""
echo "==> Next steps:"
echo "   1. Point DNS records to this server"
echo "   2. Run: ./scripts/setup-nginx.sh   OR   ./scripts/setup-caddy.sh"
echo "   3. Edit /opt/quicksave/.env and add your GitHub token (repo scope)"
echo "   4. Create GitHub environments with secrets above"
echo "   5. Restart webhook: systemctl restart webhook"
echo ""
echo "==> Web Push (VAPID) — optional but required for phone notifications:"
echo "   a. Generate a key pair once (on any machine):"
echo "        npx web-push generate-vapid-keys"
echo "   b. Put the same keys in:"
echo "        /opt/quicksave/production/relay.env"
echo "        /opt/quicksave/staging/relay.env"
echo "   c. Restart: systemctl restart quicksave-signaling quicksave-signaling-staging"
echo "   d. Add VAPID_PUBLIC_KEY as a GitHub Actions variable for each"
echo "      environment so the PWA bundle embeds it (VITE_VAPID_PUBLIC_KEY)."
echo ""
