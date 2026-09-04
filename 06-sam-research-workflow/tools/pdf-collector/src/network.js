import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NTNU_VPN_PREFIXES } from './constants.js';

const execFileAsync = promisify(execFile);

export function listIpv4(networkInterfaces = os.networkInterfaces()) {
  const result = [];
  for (const [name, entries] of Object.entries(networkInterfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push({ name, address: entry.address });
    }
  }
  return result;
}

export function detectNtnuVpn(networkInterfaces = os.networkInterfaces()) {
  const addresses = listIpv4(networkInterfaces);
  const campus = addresses.find(({ address }) => NTNU_VPN_PREFIXES.some((prefix) => address.startsWith(prefix)));
  return { connected: Boolean(campus), campusAddress: campus?.address || null, interfaceName: campus?.name || null, addresses };
}

async function queryService(name) {
  try {
    const { stdout } = await execFileAsync('sc.exe', ['query', name], { windowsHide: true, timeout: 5000 });
    return { name, installed: true, running: /STATE\s*:\s*4\s+RUNNING/i.test(stdout) };
  } catch (error) {
    return { name, installed: false, running: false, error: error.code || 'unknown' };
  }
}

export async function getVpnStatus() {
  const route = detectNtnuVpn();
  const services = await Promise.all(['F5TrafficSrv', 'F5FltSrv', 'F5PrelogonHelperService64'].map(queryService));
  return {
    ...route,
    f5Installed: services.some((service) => service.installed),
    f5ServicesRunning: services.some((service) => service.running),
    services,
    checkedAt: new Date().toISOString(),
  };
}
