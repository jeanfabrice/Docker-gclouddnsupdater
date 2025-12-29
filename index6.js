#!/usr/bin/env node

const { exec } = require('child_process');
const { DNS } = require('@google-cloud/dns');
const https = require('node:https');
const Unifi = require('node-unifi');
const k8s = require('@kubernetes/client-node');

const dns = new DNS();

// ---------- Configuration UniFi ----------
const unifiConfig = {
  host: process.env.UNIFI_HOST,
  username: process.env.UNIFI_USERNAME,
  password: process.env.UNIFI_PASSWORD,
  site: process.env.UNIFI_SITE || 'default',
  port: process.env.UNIFI_PORT || 443,
  sslVerify: false
};

// ---------- Helpers ----------

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout) => {
      if (err) return reject(err);
      const lines = stdout.trim().split('\n');
      resolve(lines[0].trim());
    });
  });
}

function ensureTrailingDot(name) {
  if (!name) return '';
  return name.endsWith('.') ? name : name + '.';
}

// ---------- Initialisation des Mappings ----------
// Mapping UniFi (domaine=NomDuGroupeFirewall)
const unifiMapping = {};
if (process.env.UNIFI_FIREWALL_MAPPING) {
  process.env.UNIFI_FIREWALL_MAPPING.split(',').forEach(item => {
    const [domain, group] = item.split('=');
    if (domain && group) {
      unifiMapping[ensureTrailingDot(domain.trim())] = group.trim();
    }
  });
}

// Mapping Kubernetes Services (domaine=namespace/nom-service)
const k8sMapping = {};
if (process.env.K8S_SERVICE_MAPPING) {
  process.env.K8S_SERVICE_MAPPING.split(',').forEach(item => {
    const [domain, path] = item.split('=');
    if (domain && path) {
      const [ns, svc] = path.trim().split('/');
      if (ns && svc) {
        k8sMapping[ensureTrailingDot(domain.trim())] = { ns, svc };
      }
    }
  });
}

// Mapping MetalLB Pools (namespace/nom-pool/suffixe_64)
// Exemple: K8S_METALLB_POOL_MAPPING=metallb-system/default-pool/de
const metallbPools = [];
if (process.env.K8S_METALLB_POOL_MAPPING) {
  process.env.K8S_METALLB_POOL_MAPPING.split(',').forEach(item => {
    const [ns, pool, suffix] = item.trim().split('/');
    if (ns && pool && suffix) {
      metallbPools.push({ ns, pool, suffix });
    }
  });
}

// ---------- Logic Kubernetes Service ----------

async function updateK8sService(namespace, serviceName, newIp) {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromDefault();
    const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

    const service = await k8sApi.readNamespacedService({
      name: serviceName,
      namespace: namespace
    });

    const annotations = service.metadata.annotations || {};
    const lbAnnotationKey = 'metallb.io/loadBalancerIPs';
    const currentVal = annotations[lbAnnotationKey] || '';

    const existingIps = currentVal.split(',').map(s => s.trim()).filter(Boolean);
    const ipv4 = existingIps.find(ip => !ip.includes(':'));
    const newVal = ipv4 ? `${ipv4},${newIp}` : newIp;

    if (currentVal === newVal) {
      console.log(`[Kubernetes] Service ${namespace}/${serviceName} up-to-date.`);
      return;
    }

    const patchPayload = {
      metadata: {
        annotations: {
          [lbAnnotationKey]: newVal
        }
      }
    };

    await k8sApi.patchNamespacedService(
      {
        name: serviceName,
        namespace: namespace,
        body: patchPayload
      },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch)
    );

    console.log(`[Kubernetes] Service ${namespace}/${serviceName} updated: ${lbAnnotationKey} = ${newVal}`);
  } catch (err) {
    const errMsg = err.response ? JSON.stringify(err.response.body) : err.message;
    const logMsg = `[Kubernetes] Error while updating ${namespace}/${serviceName}: ${errMsg}`;
    console.error(logMsg);
    await sendWebhook(`Kubernetes Error (${namespace}/${serviceName}): ${errMsg}`);
  }
}

// ---------- Logic Kubernetes MetalLB Pool ----------

async function updateK8sMetalLBPool(namespace, poolName, prefixBytes, suffixStr) {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromDefault();
    const k8sApi = kc.makeApiClient(k8s.CustomObjectsApi);

    const ipaddresspool = await k8sApi.getNamespacedCustomObject({
      group: 'metallb.io',
      version: 'v1beta1',
      namespace: namespace,
      plural: 'ipaddresspools',
      name: poolName
    });

    const addresses = ipaddresspool.spec.addresses || [];

    // Construction du nouveau réseau IPv6 (Préfixe + suffixe de portion /120)
    const finalBytes = buildIpv6FromPrefixAndSuffixBytes(prefixBytes, suffixStr);
    const newIpv6Network = bytesToIpv6(finalBytes) + '/120';

    // Conservation de l'IPv4, remplacement de l'IPv6
    const ipv4Range = addresses.find(a => !a.includes(':'));
    const currentIpv6 = addresses.find(a => a.includes(':'));

    if (currentIpv6 === newIpv6Network) {
      console.log(`[MetalLB] IPAddressPool ${poolName} up-to-date.`);
      return;
    }

    const newAddresses = ipv4Range ? [ipv4Range, newIpv6Network] : [newIpv6Network];

    const patchPayload = {
      spec: {
        addresses: newAddresses
      }
    };

    await k8sApi.patchNamespacedCustomObject(
      {
        group: 'metallb.io',
        version: 'v1beta1',
        namespace: namespace,
        plural: 'ipaddresspools',
        name: poolName,
        body: patchPayload
      },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch)
    );

    console.log(`[MetalLB] IPAddressPool ${poolName} updated: ${newIpv6Network}`);
  } catch (err) {
    const errMsg = err.response ? JSON.stringify(err.response.body) : err.message;
    console.error(`[MetalLB] Error while updating ${poolName}:`, errMsg);
    await sendWebhook(`Kubernetes Error (${poolName}): ${errMsg}`);
  }
}

// ---------- UniFi Logic ----------

async function updateUnifiFirewall(groupName, newIp) {
  if (!unifiConfig.host || !unifiConfig.username) return;

  const unifi = new Unifi.Controller({
    host: unifiConfig.host,
    port: unifiConfig.port,
    sslverify: unifiConfig.sslVerify,
    site: unifiConfig.site
  });

  try {
    await unifi.login(unifiConfig.username, unifiConfig.password);

    const groups = await unifi.getFirewallGroups();
    const targetGroup = groups.find(g => g.name === groupName);

    if (!targetGroup) {
      const msg = `[UniFi] Unknown firewall group: ${groupName}`;
      console.error(msg);
      await sendWebhook(msg);
      return;
    }

    if (targetGroup.group_members.includes(newIp) && targetGroup.group_members.length === 1) {
      console.log(`[UniFi] Firewall group ${groupName} up-to-date.`);
      return;
    }

    await unifi.editFirewallGroup(
      targetGroup._id,
      targetGroup.site_id,
      targetGroup.name,
      targetGroup.group_type,
      [newIp]
    );

    console.log(`[UniFi] Firewall group ${groupName} updated: ${newIp}`);
    await unifi.logout();
  } catch (err) {
    const logMsg = `[UniFi] Error while updating ${groupName}: ${err.message}`;
    console.error(logMsg);
    await sendWebhook(logMsg);
  }
}

// ---------- Notification ----------

async function sendWebhook(text) {
  if (!process.env.WEBHOOK_URL) return;
  return new Promise((resolve) => {
    try {
      const req = https.request(process.env.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      }, () => resolve());
      req.on('error', () => resolve());
      req.write(JSON.stringify({ text }));
      req.end();
    } catch {
      resolve();
    }
  });
}

// ---------- IP Detection ----------

async function getPublicIPv4() {
  try {
    const ip = await execAsync('dig +short myip.opendns.com @resolver4.opendns.com');
    return /^\d+(\.\d+){3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

async function getPublicIPv6() {
  try {
    const ip = await execAsync('dig -6 +short AAAA myip.opendns.com @resolver1.opendns.com');
    return ip && ip.includes(':') ? ip : null;
  } catch {
    return null;
  }
}

// ---------- IPv6 Helpers ----------

function ipv6ToBytes(ip) {
  if (ip.includes('.')) throw new Error('IPv6 with embedded IPv4 not supported');
  const parts = ip.split('::');
  let left = [], right = [];
  if (parts.length === 1) left = ip.split(':').filter(Boolean);
  else if (parts.length === 2) {
    left = parts[0] === '' ? [] : parts[0].split(':').filter(Boolean);
    right = parts[1] === '' ? [] : parts[1].split(':').filter(Boolean);
  } else throw new Error('Invalid IPv6');
  const missing = 8 - (left.length + right.length);
  const hextets = [...left, ...Array(missing).fill('0'), ...right];
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) buf.writeUInt16BE(parseInt(hextets[i], 16), i * 2);
  return buf;
}

function bytesToIpv6(buf) {
  const hextets = [];
  for (let i = 0; i < 8; i++) hextets.push(buf.readUInt16BE(i * 2).toString(16));
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (hextets[i] === '0') {
      if (curStart === -1) { curStart = i; curLen = 1; }
      else { curLen++; }
    } else {
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      curStart = -1; curLen = 0;
    }
  }
  if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
  if (bestLen <= 1) return hextets.join(':');
  const left = hextets.slice(0, bestStart).join(':');
  const right = hextets.slice(bestStart + bestLen).join(':');
  if (left === '' && right === '') return '::';
  if (left === '') return `::${right}`;
  if (right === '') return `${left}::`;
  return `${left}::${right}`;
}

function tokensToBytes(tokens) {
  const arr = [];
  for (const t of tokens) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(t)) throw new Error(`Invalid hex token '${t}'`);
    const padded = t.length % 2 === 1 ? '0' + t : t;
    for (let i = 0; i < padded.length; i += 2) arr.push(parseInt(padded.substring(i, i + 2), 16));
  }
  return Buffer.from(arr);
}

function parseSuffixToBytes(suffix) {
  if (!suffix) return Buffer.alloc(0);
  const parts = suffix.split('::');
  const leftTokens = parts[0] === '' ? [] : parts[0].split(':').filter(Boolean);
  const rightTokens = parts.length === 2 && parts[1] !== '' ? parts[1].split(':').filter(Boolean) : [];
  const leftBytes = tokensToBytes(leftTokens);
  const rightBytes = tokensToBytes(rightTokens);
  const total = leftBytes.length + rightBytes.length;
  if (total > 9) throw new Error(`Suffix expands to ${total} bytes > 9 bytes allowed`);
  const zeros = Buffer.alloc(9 - total);
  return Buffer.concat([leftBytes, zeros, rightBytes]);
}

function buildIpv6FromPrefixAndSuffixBytes(prefixBytes, suffixStr) {
  const out = Buffer.alloc(16, 0);
  prefixBytes.copy(out, 0, 0, 7);
  const tail = parseSuffixToBytes(suffixStr);
  tail.copy(out, 7, 0, tail.length);
  return out;
}

// ---------- DNS helpers ----------

async function updateOrCreate(zone, name, type, value) {
  try {
    const [recs] = await zone.getRecords({ name, type });
    const rec = recs && recs.length ? recs[0] : null;
    if (rec) {
      const existing = rec.data && rec.data[0];
      if (existing === value) {
        console.log(`[DNS] ${name} ${type} up-to-date (${value})`);
        return false;
      }
      const newRec = zone.record(type.toLowerCase(), { name, data: value, ttl: rec.ttl || 60 });
      await zone.replaceRecords(rec.type, newRec);
      console.log(`[DNS] Updated ${type} ${name}: ${existing} -> ${value}`);
      return true;
    } else {
      const newRec = zone.record(type.toLowerCase(), { name, data: value, ttl: 60 });
      await zone.addRecords(newRec);
      console.log(`[DNS] Created ${type} ${name}: ${value}`);
      return true;
    }
  } catch (err) {
    const logMsg = `[DNS] DNS Error ${name} ${type}: ${err.message}`;
    console.error(logMsg);
    await sendWebhook(logMsg);
    return false;
  }
}

// ---------- Main ----------

(async function main() {
  try {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS');
    if (!process.env.GCLOUD_DNS_ZONE) throw new Error('Missing GCLOUD_DNS_ZONE');

    const zone = dns.zone(process.env.GCLOUD_DNS_ZONE);
    const changed = [];

    // IPv4 Update
    try {
      if (process.env.GCLOUD_DNS_NAME) {
        const ipv4 = await getPublicIPv4();
        if (!ipv4) {
          console.error('Cannot determine public IPv4, skipping A records.');
        } else {
          const names = process.env.GCLOUD_DNS_NAME.split(',').map(s => s.trim()).filter(Boolean);
          for (const raw of names) {
            const name = ensureTrailingDot(raw);
            if (await updateOrCreate(zone, name, 'A', ipv4)) {
              changed.push(`${name} A -> ${ipv4}`);
            }
          }
        }
      }
    } catch (err) {
      console.error('IPv4 block error:', err.message);
      await sendWebhook(`Erreur bloc IPv4: ${err.message}`);
    }

    // IPv6 Update
    try {
      if (process.env.GCLOUD_DNS_NAME6) {
        const ipv6pub = await getPublicIPv6();
        if (!ipv6pub) {
          console.error('Cannot determine public IPv6, skipping AAAA records.');
        } else {
          const prefixBytes = ipv6ToBytes(ipv6pub);

          // 1. Mise à jour des pools MetalLB (Portion /64)
          for (const p of metallbPools) {
            await updateK8sMetalLBPool(p.ns, p.pool, prefixBytes, p.suffix);
          }

          // 2. Boucle par domaine (DNS, UniFi, K8s Services)
          const entries = process.env.GCLOUD_DNS_NAME6.split(',').map(s => s.trim()).filter(Boolean);
          for (const entry of entries) {
            const idx = entry.indexOf('=');
            if (idx === -1) continue;

            const rawName = entry.slice(0, idx).trim();
            const suffix = entry.slice(idx + 1).trim();
            const name = ensureTrailingDot(rawName);

            try {
              const finalBytes = buildIpv6FromPrefixAndSuffixBytes(prefixBytes, suffix);
              const finalIp = bytesToIpv6(finalBytes);

              // 2.1. DNS
              if (await updateOrCreate(zone, name, 'AAAA', finalIp)) {
                changed.push(`${name} AAAA -> ${finalIp}`);
              }

              // 2.2. UniFi Firewall
              const unifiGroupName = unifiMapping[name];
              if (unifiGroupName) {
                await updateUnifiFirewall(unifiGroupName, finalIp);
              }

              // 2.3. Kubernetes Service
              const kInfo = k8sMapping[name];
              if (kInfo) {
                await updateK8sService(kInfo.ns, kInfo.svc, finalIp);
              }
            } catch (err) {
              console.error(`Error AAAA ${entry}:`, err.message);
              await sendWebhook(`Erreur sur ${entry}: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      console.error('IPv6 block error:', err.message);
      await sendWebhook(`Erreur bloc IPv6: ${err.message}`);
    }

    if (changed.length) {
      console.log('Changes:', changed.join('; '));
      await sendWebhook(`DNS, Firewall & K8s updates:\n${changed.join('\n')}`);
    } else {
      console.log('No changes needed.');
    }

  } catch (globalError) {
    console.error('FATAL ERROR:', globalError.message);
    await sendWebhook(`ERREUR FATALE DDNS: ${globalError.message}`);
  } finally {
    setImmediate(() => process.exit(0));
  }
})();
