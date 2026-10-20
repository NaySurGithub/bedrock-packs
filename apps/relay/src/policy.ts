import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();
const globalIpv6 = new BlockList();

globalIpv6.addSubnet('2000::', 3, 'ipv6');

for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
] as const) {
    blockedIpv4.addSubnet(address, prefix, 'ipv4');
}

blockedIpv6.addSubnet('2001::', 23, 'ipv6');
blockedIpv6.addSubnet('2001:db8::', 32, 'ipv6');
blockedIpv6.addSubnet('2002::', 16, 'ipv6');

export function isPublicAddress(address: string): boolean {
    const family = isIP(address);

    if (family === 4) {
        return !blockedIpv4.check(address, 'ipv4');
    }

    if (family === 6) {
        return globalIpv6.check(address, 'ipv6') && !blockedIpv6.check(address, 'ipv6');
    }

    return false;
}

export interface DestinationPolicy {
    allowedPorts: ReadonlySet<number>;
    allowedHosts: ReadonlySet<string>;
}

export async function resolveTarget(host: string, port: number, policy: DestinationPolicy) {
    if (!Number.isInteger(port) || !policy.allowedPorts.has(port)) {
        throw new Error('Destination port is not allowed.');
    }

    if (host.length === 0 || host.length > 253 || /[\s/@?#\\%\[\]]/.test(host)) {
        throw new Error('Invalid server address.');
    }

    const normalizedHost = host.toLowerCase();

    if (policy.allowedHosts.size > 0 && !policy.allowedHosts.has(normalizedHost)) {
        throw new Error('Destination host is not allowed.');
    }

    const resolvedAddresses = await lookup(normalizedHost, {
        all: true,
    });

    const publicAddress = resolvedAddresses.find((entry) => isPublicAddress(entry.address));

    if (!publicAddress) {
        throw new Error('Destination must resolve to a public IP address.');
    }

    // Connect to this resolved IP, never resolve the hostname again after validation.
    return publicAddress;
}
