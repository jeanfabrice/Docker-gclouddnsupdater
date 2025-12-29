# Google Cloud DNS Updater

A Node.js script that automatically updates DNS records in Google Cloud DNS based on your current public IP addresses (IPv4 and IPv6). It also supports integration with UniFi firewall groups and Kubernetes services for comprehensive network automation.

## Features

- **IPv4 DNS Updates**: Automatically updates A records in Google Cloud DNS with your current public IPv4 address
- **IPv6 DNS Updates**: Updates AAAA records with dynamically generated IPv6 addresses based on your public IPv6 prefix
- **UniFi Integration**: Updates UniFi firewall group members with new IP addresses
- **Kubernetes Integration**:
  - Updates Kubernetes Service annotations for MetalLB LoadBalancer IPs
  - Updates MetalLB IPAddressPool resources with IPv6 network ranges
- **Webhook Notifications**: Sends notifications to a webhook URL on errors or successful updates

## How It Works

1. **IP Detection**: The script detects your current public IPv4 and IPv6 addresses using OpenDNS resolvers
2. **IPv4 Processing**: For each domain in `GCLOUD_DNS_NAME`, updates the A record with the detected IPv4
3. **IPv6 Processing**:
   - Extracts the first 7 bytes (56 bits) from your public IPv6 prefix
   - For each domain in `GCLOUD_DNS_NAME6`, combines the prefix with a custom suffix to create a unique IPv6 address
   - Updates DNS AAAA records, UniFi firewall groups, and Kubernetes services accordingly
4. **MetalLB Pools**: Updates MetalLB IPAddressPool resources with new IPv6 network ranges (/120) based on the public prefix

## Prerequisites

- Node.js 20+ (or use the provided Docker image)
- Google Cloud Platform account with DNS API enabled
- Service account credentials with DNS Admin permissions
- (Optional) UniFi Controller access
- (Optional) Kubernetes cluster access (in-cluster config or kubeconfig)
- `dig` command available (included in Docker image)

## Installation

### Using Docker (Recommended)

```bash
docker build -t gclouddnsupdater .
```

### Using Node.js directly

```bash
npm install
```

## Environment Variables

### Required Variables

#### `GOOGLE_APPLICATION_CREDENTIALS`

Path to your Google Cloud service account JSON key file.

**Example:**

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

#### `GCLOUD_DNS_ZONE`

Name of your Google Cloud DNS managed zone.

**Example:**

```bash
GCLOUD_DNS_ZONE=my-dns-zone
```

### Optional Variables

#### `GCLOUD_DNS_NAME`

Comma-separated list of domain names to update with IPv4 addresses (A records). Domains are automatically normalized with a trailing dot.

**Example:**

```bash
GCLOUD_DNS_NAME=example.com,www.example.com,api.example.com
```

#### `GCLOUD_DNS_NAME6`

Comma-separated list of domain names with IPv6 suffixes. Format: `domain=suffix`, where suffix is the last 9 bytes of the IPv6 address (in hex format).

**Example:**

```bash
GCLOUD_DNS_NAME6=example.com=::1,www.example.com=::2,api.example.com=de:ad:be:ef::1
```

**IPv6 Suffix Format:**

- The suffix represents bytes 8-16 of the final IPv6 address
- Use standard IPv6 notation with `::` for zero compression
- Examples:
  - `::1` → `0000:0000:0000:0000:0000:0000:0000:0001`
  - `de:ad:be:ef::1` → `00de:00ad:00be:00ef:0000:0000:0000:0001`
  - `2001:db8::1` → `2001:0db8:0000:0000:0000:0000:0000:0001`

#### `WEBHOOK_URL`

URL to send webhook notifications (JSON format: `{"text": "message"}`). Used for error notifications and update summaries.

**Example:**

```bash
WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

#### `UNIFI_HOST`

Hostname or IP address of your UniFi Controller.

**Example:**

```bash
UNIFI_HOST=unifi.example.com
```

#### `UNIFI_USERNAME`

Username for UniFi Controller authentication.

**Example:**

```bash
UNIFI_USERNAME=admin
```

#### `UNIFI_PASSWORD`

Password for UniFi Controller authentication.

**Example:**

```bash
UNIFI_PASSWORD=your-secure-password
```

#### `UNIFI_SITE`

UniFi site name. Defaults to `default` if not specified.

**Example:**

```bash
UNIFI_SITE=default
```

#### `UNIFI_PORT`

UniFi Controller port. Defaults to `443` if not specified.

**Example:**

```bash
UNIFI_PORT=443
```

**Note:** SSL verification is currently disabled for UniFi connections. Use with caution in production environments.

#### `UNIFI_FIREWALL_MAPPING`

Comma-separated mapping of domain names to UniFi firewall group names. Format: `domain=group-name`.

**Example:**

```bash
UNIFI_FIREWALL_MAPPING=example.com=Web-Servers,www.example.com=Web-Servers,api.example.com=API-Servers
```

#### `K8S_SERVICE_MAPPING`

Comma-separated mapping of domain names to Kubernetes services. Format: `domain=namespace/service-name`. Updates the `metallb.io/loadBalancerIPs` annotation.

**Example:**

```bash
K8S_SERVICE_MAPPING=example.com=default/example-service,www.example.com=production/web-service
```

#### `K8S_METALLB_POOL_MAPPING`

Comma-separated list of MetalLB IPAddressPool resources to update. Format: `namespace/pool-name/suffix`. The suffix is used to construct the IPv6 network (/120) for the pool.

**Example:**

```bash
K8S_METALLB_POOL_MAPPING=metallb-system/default-pool/de,metallb-system/production-pool/ad:be:ef
```

## Usage

### Docker

```bash
docker run --rm \
  -v /path/to/service-account-key.json:/creds/key.json:ro \
  -e GOOGLE_APPLICATION_CREDENTIALS=/creds/key.json \
  -e GCLOUD_DNS_ZONE=my-dns-zone \
  -e GCLOUD_DNS_NAME=example.com \
  -e GCLOUD_DNS_NAME6=example.com=::1 \
  -e WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL \
  gclouddnsupdater
```

### Node.js

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
export GCLOUD_DNS_ZONE=my-dns-zone
export GCLOUD_DNS_NAME=example.com
export GCLOUD_DNS_NAME6=example.com=::1
export WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

node index6.js
```

### Kubernetes CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: dns-updater
spec:
  schedule: "*/5 * * * *"  # Every 5 minutes
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: dns-updater
            image: gclouddnsupdater:latest
            env:
            - name: GOOGLE_APPLICATION_CREDENTIALS
              value: /creds/key.json
            - name: GCLOUD_DNS_ZONE
              value: "my-dns-zone"
            - name: GCLOUD_DNS_NAME
              value: "example.com,www.example.com"
            - name: GCLOUD_DNS_NAME6
              value: "example.com=::1,www.example.com=::2"
            - name: WEBHOOK_URL
              valueFrom:
                secretKeyRef:
                  name: webhook-secret
                  key: url
            volumeMounts:
            - name: gcp-creds
              mountPath: /creds
              readOnly: true
          volumes:
          - name: gcp-creds
            secret:
              secretName: gcp-dns-credentials
          restartPolicy: OnFailure
```

## How IPv6 Suffix Works

The script uses a clever approach to generate unique IPv6 addresses:

1. **Public IPv6 Detection**: Gets your current public IPv6 address (e.g., `2001:db8::1`)
2. **Prefix Extraction**: Takes the first 7 bytes (56 bits) as the prefix
3. **Suffix Combination**: Combines the prefix with your custom suffix (bytes 8-16)
4. **Final Address**: Creates a complete 128-bit IPv6 address

**Example:**

- Public IPv6: `2001:0db8:0000:0000:0000:0000:0000:0001`
- Prefix (bytes 0-7): `2001:0db8:0000:0000:00`
- Suffix (bytes 8-16): `::1` → `0000:0000:0000:0001`
- Final IPv6: `2001:0db8:0000:0000:0000:0000:0000:0001`

This allows you to maintain stable IPv6 addresses even when your public prefix changes, by only updating the prefix portion while keeping your custom suffix.

## Kubernetes Integration Details

### Service Annotations

The script updates the `metallb.io/loadBalancerIPs` annotation on Kubernetes services. It preserves existing IPv4 addresses and appends the new IPv6 address.

**Example:**

- Before: `metallb.io/loadBalancerIPs: "192.168.1.100"`
- After: `metallb.io/loadBalancerIPs: "192.168.1.100,2001:db8::1"`

### MetalLB IPAddressPool

For MetalLB pools, the script:

- Preserves existing IPv4 address ranges
- Updates or adds IPv6 network ranges with `/120` prefix length
- Constructs the IPv6 network from the public prefix + custom suffix

## Error Handling

- All errors are logged to console with context
- Errors trigger webhook notifications (if `WEBHOOK_URL` is set)
- Individual domain/service updates continue even if one fails
- Fatal errors cause the script to exit with an error code

## Logging

The script provides detailed logging:

- `[DNS]` - DNS record updates
- `[Kubernetes]` - Kubernetes service updates
- `[MetalLB]` - MetalLB pool updates
- `[UniFi]` - UniFi firewall group updates
- `[Webhook]` - Webhook notification errors (if any)

## Security Considerations

- **Service Account**: Use a service account with minimal required permissions (DNS Admin)
- **Credentials**: Never commit service account keys to version control
- **UniFi SSL**: SSL verification is currently disabled. Consider enabling it in production
- **Secrets**: Use Kubernetes secrets or environment variable management tools for sensitive data

## Troubleshooting

### DNS Updates Not Working

- Verify `GOOGLE_APPLICATION_CREDENTIALS` path is correct
- Check service account has DNS Admin role
- Verify `GCLOUD_DNS_ZONE` matches your zone name exactly

### IPv6 Detection Fails

- Ensure your network has IPv6 connectivity
- Check that `dig` command is available
- Verify OpenDNS resolvers are reachable

### Kubernetes Updates Fail

- Verify kubeconfig is accessible (or running in-cluster)
- Check service account has permissions to patch services
- For MetalLB pools, ensure CustomResourceDefinitions are installed

### UniFi Updates Fail

- Verify UniFi Controller is reachable
- Check credentials are correct
- Ensure firewall group names match exactly (case-sensitive)

## License

MIT
