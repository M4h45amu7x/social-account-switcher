// Local https stand-ins for real sites, shared by the e2e specs that need a real page load (YouTube
// switching, the fake Facebook / Instagram). One `node:https` server answers for every mapped host. Its
// certificate is made for the run with openssl and deleted as soon as it is read. Chromium sends the
// mapped hosts to 127.0.0.1 and every other name to NOTFOUND, so no request can leave the machine.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { launchExtension } from './fixtures';

export type SiteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

export interface HttpsSites {
  readonly port: number;
  /** Every host the server was asked for, from the Host header. */
  readonly hostsSeen: Set<string>;
  /** Chromium flags that send `hosts` to this server and nothing anywhere else. */
  readonly args: string[];
  close(): Promise<void>;
}

/** A self-signed certificate for `hosts`, made for this run. Nothing is left on disk. */
function makeCertificate(hosts: readonly string[]): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'sas-tls-'));
  try {
    const keyFile = join(dir, 'key.pem');
    const certFile = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${hosts[0] ?? 'localhost'}`,
        '-addext',
        `subjectAltName=${hosts.map((h) => `DNS:${h}`).join(',')}`,
        '-keyout',
        keyFile,
        '-out',
        certFile,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function startHttpsSites(
  hosts: readonly string[],
  handler: SiteHandler,
): Promise<HttpsSites> {
  const hostsSeen = new Set<string>();
  const server = createServer(makeCertificate(hosts), (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0] ?? '';
    hostsSeen.add(host);
    const url = new URL(req.url ?? '/', `https://${host}`);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    handler(req, res, url);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const map = hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(', ');
  return {
    port,
    hostsSeen,
    args: [`--host-resolver-rules=${map}, MAP * ~NOTFOUND`, '--ignore-certificate-errors'],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The extension in Chromium with `hosts` served locally. `close` stops both and deletes the profile. */
export async function launchWithSites(
  hosts: readonly string[],
  handler: SiteHandler,
): Promise<{ context: BrowserContext; sites: HttpsSites; close(): Promise<void> }> {
  const sites = await startHttpsSites(hosts, handler);
  const launched = await launchExtension({ extraArgs: sites.args }).catch(async (error) => {
    await sites.close();
    throw error;
  });
  return {
    context: launched.context,
    sites,
    close: async () => {
      await launched.close();
      await sites.close();
    },
  };
}

/**
 * Calls the stand-in from the test itself (not through the browser), e.g. a control endpoint of a fake
 * site. The certificate is the run's own self-signed one, so it is not checked.
 */
export function callSite(sites: HttpsSites, host: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: sites.port,
        path,
        method: 'POST',
        headers: { host },
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
