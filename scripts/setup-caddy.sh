#!/bin/bash
#
# Setup Caddy as reverse proxy
# Simpler config, automatic SSL via Let's Encrypt
#
# Usage: ssh root@your-server 'bash -s' < scripts/setup-caddy.sh
#
set -e

DOMAIN="${DOMAIN:-localhost}"
STAGING_DOMAIN="staging.${DOMAIN}"
SIGNAL_DOMAIN="signal.${DOMAIN}"
SIGNAL_STAGING_DOMAIN="signal-staging.${DOMAIN}"

echo "==> Installing Caddy..."
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

echo "==> Configuring Caddy..."
cat > /etc/caddy/Caddyfile << EOF
# Production PWA
${DOMAIN} {
    root * /opt/quicksave/production/apps/pwa/dist
    encode gzip

    @assets path /assets/*
    handle @assets {
        header Cache-Control "public, immutable"
        file_server
    }

    @appShell path /index.html
    handle @appShell {
        header Cache-Control "no-store"
        file_server
    }

    @sw path /sw.js /manifest.webmanifest
    handle @sw {
        header Cache-Control "no-cache"
        file_server
    }

    handle {
        try_files {path} /index.html
        file_server
    }

    header {
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}

# Staging PWA
${STAGING_DOMAIN} {
    root * /opt/quicksave/staging/apps/pwa/dist
    encode gzip

    @assets path /assets/*
    handle @assets {
        header Cache-Control "public, immutable"
        file_server
    }

    @appShell path /index.html
    handle @appShell {
        header Cache-Control "no-store"
        file_server
    }

    @sw path /sw.js /manifest.webmanifest
    handle @sw {
        header Cache-Control "no-cache"
        file_server
    }

    handle {
        try_files {path} /index.html
        file_server
    }
}

# Production Signaling + Webhook
${SIGNAL_DOMAIN} {
    handle /hooks/* {
        reverse_proxy localhost:9000
    }
    handle {
        reverse_proxy localhost:8080
    }
}

# Staging Signaling + Webhook
${SIGNAL_STAGING_DOMAIN} {
    handle /hooks/* {
        reverse_proxy localhost:9000
    }
    handle {
        reverse_proxy localhost:8081
    }
}
EOF

echo "==> Starting Caddy..."
systemctl enable caddy
systemctl restart caddy

echo ""
echo "==> Caddy setup complete!"
echo ""
echo "Domains configured:"
echo "  - https://${DOMAIN} (production PWA)"
echo "  - https://${STAGING_DOMAIN} (staging PWA)"
echo "  - https://${SIGNAL_DOMAIN} (production signaling)"
echo "  - https://${SIGNAL_STAGING_DOMAIN} (staging signaling)"
echo ""
echo "SSL certificates will be provisioned automatically once DNS propagates."
echo ""
