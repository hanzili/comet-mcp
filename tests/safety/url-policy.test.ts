import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  isInternalUrl,
  isFileUrl,
  isBlockedDocType,
  extractHost,
  matchWildcard,
  checkUrl,
  assertUrlAllowed,
  BlockedUrlError,
  DEFAULT_POLICY,
  normalizePolicy,
  setActivePolicy,
  resetActivePolicy,
  getActivePolicy,
  resolvePolicyPath,
  loadPolicyFromFile,
} from '../../src/safety/url-policy.js';

describe('isInternalUrl', () => {
  it('matches chrome:// schemes', () => {
    expect(isInternalUrl('chrome://settings')).toBe(true);
    expect(isInternalUrl('chrome://password-manager')).toBe(true);
    expect(isInternalUrl('chrome://flags')).toBe(true);
  });

  it('matches other internal browser schemes', () => {
    expect(isInternalUrl('chrome-untrusted://terminal')).toBe(true);
    expect(isInternalUrl('chrome-extension://abcdef/popup.html')).toBe(true);
    expect(isInternalUrl('chrome-search://local-ntp/local-ntp.html')).toBe(true);
    expect(isInternalUrl('chrome-error://chromewebdata/')).toBe(true);
    expect(isInternalUrl('devtools://devtools/bundled/devtools_app.html')).toBe(true);
    expect(isInternalUrl('edge://settings')).toBe(true);
    expect(isInternalUrl('about:blank')).toBe(true);
    expect(isInternalUrl('view-source:https://example.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isInternalUrl('CHROME://Settings')).toBe(true);
    expect(isInternalUrl('About:Blank')).toBe(true);
  });

  it('does NOT match normal http(s) URLs', () => {
    expect(isInternalUrl('https://google.com')).toBe(false);
    expect(isInternalUrl('http://example.com/path')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isInternalUrl('')).toBe(false);
  });
});

describe('isFileUrl', () => {
  it('matches file:// and ftp://', () => {
    expect(isFileUrl('file:///c:/Users/x/secrets.txt')).toBe(true);
    expect(isFileUrl('file:///etc/passwd')).toBe(true);
    expect(isFileUrl('ftp://internal.corp/file')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isFileUrl('FILE:///c:/x')).toBe(true);
  });

  it('does NOT match http(s)', () => {
    expect(isFileUrl('https://example.com')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isFileUrl('')).toBe(false);
  });
});

describe('isBlockedDocType', () => {
  it('matches Windows executables', () => {
    expect(isBlockedDocType('https://download.example.com/installer.exe')).toBe(true);
    expect(isBlockedDocType('https://x.com/setup.msi')).toBe(true);
    expect(isBlockedDocType('https://x.com/old.bat')).toBe(true);
  });

  it('matches shell scripts', () => {
    expect(isBlockedDocType('https://x.com/install.sh')).toBe(true);
    expect(isBlockedDocType('https://x.com/run.bash')).toBe(true);
    expect(isBlockedDocType('https://x.com/mac.command')).toBe(true);
  });

  it('matches disk images and packages', () => {
    expect(isBlockedDocType('https://x.com/app.dmg')).toBe(true);
    expect(isBlockedDocType('https://x.com/pkg.pkg')).toBe(true);
    expect(isBlockedDocType('https://x.com/disk.iso')).toBe(true);
  });

  it('strips query string and fragment', () => {
    expect(isBlockedDocType('https://x.com/install.exe?download=1')).toBe(true);
    expect(isBlockedDocType('https://x.com/install.exe#section')).toBe(true);
    expect(isBlockedDocType('https://x.com/install.exe?x=1#y=2')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isBlockedDocType('https://x.com/INSTALL.EXE')).toBe(true);
  });

  it('does NOT match safe document types', () => {
    expect(isBlockedDocType('https://x.com/doc.pdf')).toBe(false);
    expect(isBlockedDocType('https://x.com/data.csv')).toBe(false);
    expect(isBlockedDocType('https://x.com/image.png')).toBe(false);
    expect(isBlockedDocType('https://x.com/index.html')).toBe(false);
  });

  it('does NOT false-positive on .com / .app / .jar TLDs in the host', () => {
    expect(isBlockedDocType('https://example.com')).toBe(false);
    expect(isBlockedDocType('https://myapp.app/foo')).toBe(false);
    expect(isBlockedDocType('https://api.jar/file')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isBlockedDocType('')).toBe(false);
  });

  it('returns false for paths without file extensions', () => {
    expect(isBlockedDocType('https://x.com/')).toBe(false);
    expect(isBlockedDocType('https://x.com/foo')).toBe(false);
    expect(isBlockedDocType('https://x.com/foo/bar')).toBe(false);
  });
});

describe('extractHost', () => {
  it('extracts the hostname lowercased', () => {
    expect(extractHost('https://Example.COM/path')).toBe('example.com');
    expect(extractHost('http://localhost:3000/x')).toBe('localhost');
  });

  it('strips port', () => {
    expect(extractHost('https://example.com:8443/x')).toBe('example.com');
  });

  it('returns null for malformed input', () => {
    expect(extractHost('not a url')).toBeNull();
    expect(extractHost('://broken')).toBeNull();
    expect(extractHost('')).toBeNull();
  });
});

describe('matchWildcard', () => {
  it('matches apex + subdomains for *.pattern', () => {
    expect(matchWildcard('perplexity.ai', '*.perplexity.ai')).toBe(true);
    expect(matchWildcard('www.perplexity.ai', '*.perplexity.ai')).toBe(true);
    expect(matchWildcard('api.perplexity.ai', '*.perplexity.ai')).toBe(true);
  });

  it('does not match unrelated hosts', () => {
    expect(matchWildcard('evil.com', '*.perplexity.ai')).toBe(false);
    expect(matchWildcard('perplexity.ai.evil.com', '*.perplexity.ai')).toBe(false);
  });

  it('matches exact host without wildcard prefix', () => {
    expect(matchWildcard('perplexity.ai', 'perplexity.ai')).toBe(true);
    expect(matchWildcard('sub.perplexity.ai', 'perplexity.ai')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchWildcard('WWW.Perplexity.AI', '*.perplexity.ai')).toBe(true);
  });
});

describe('checkUrl', () => {
  it('allows plain https with default policy', () => {
    const r = checkUrl('https://example.com');
    expect(r.allowed).toBe(true);
  });

  it('blocks chrome:// when blockInternal is explicitly true', () => {
    const r = checkUrl('chrome://settings', { ...DEFAULT_POLICY, blockInternal: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('internal-scheme');
  });

  it('allows chrome:// when blockInternal is false (default)', () => {
    // Default policy has blockInternal=false — internal URLs are NOT blocked.
    // Opt in with setActivePolicy or comet_set_url_policy.
    const r = checkUrl('chrome://settings');
    expect(r.allowed).toBe(true);
  });

  it('blocks file:// when blockFile is true (default)', () => {
    const r = checkUrl('file:///etc/passwd');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('file-scheme');
  });

  it('blocks executable doc types when blockDangerousExtensions is true (default)', () => {
    const r = checkUrl('https://x.com/installer.exe');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('dangerous-extension');
  });

  it('blocks denylisted domain', () => {
    const r = checkUrl('https://bank.example.com/login', {
      ...DEFAULT_POLICY,
      domainDenylist: ['*.bank.example.com'],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('domain-denylist');
  });

  it('blocks when allowlist is set and host is not on it', () => {
    const r = checkUrl('https://github.com/x', {
      ...DEFAULT_POLICY,
      domainAllowlist: ['*.mycompany.com'],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('domain-denylist');
    expect(r.message).toContain('not on the allowlist');
  });

  it('allows when host is on the allowlist', () => {
    const r = checkUrl('https://api.mycompany.com/x', {
      ...DEFAULT_POLICY,
      domainAllowlist: ['*.mycompany.com'],
    });
    expect(r.allowed).toBe(true);
  });

  it('denylist wins over allowlist', () => {
    const r = checkUrl('https://api.mycompany.com/x', {
      ...DEFAULT_POLICY,
      domainAllowlist: ['*.mycompany.com'],
      domainDenylist: ['api.mycompany.com'],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('domain-denylist');
  });

  it('returns malformed-url reason for empty/non-string input', () => {
    expect(checkUrl('').reason).toBe('malformed-url');
    // @ts-expect-error testing runtime guard
    expect(checkUrl(null).reason).toBe('malformed-url');
    // @ts-expect-error testing runtime guard
    expect(checkUrl(undefined).reason).toBe('malformed-url');
  });

  it('rejects URLs with no host when policy lists patterns', () => {
    const r = checkUrl('file:///etc/passwd', {
      ...DEFAULT_POLICY,
      blockFile: false,
      domainDenylist: ['example.com'],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('malformed-url');
  });
});

describe('assertUrlAllowed', () => {
  it('returns silently on allowed URL', () => {
    expect(() => assertUrlAllowed('https://example.com')).not.toThrow();
  });

  it('throws BlockedUrlError on disallowed URL', () => {
    expect(() => assertUrlAllowed('chrome://settings', { ...DEFAULT_POLICY, blockInternal: true })).toThrow(BlockedUrlError);
  });

  it('BlockedUrlError carries url, reason, and message', () => {
    try {
      assertUrlAllowed('chrome://settings', { ...DEFAULT_POLICY, blockInternal: true });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BlockedUrlError);
      const b = e as BlockedUrlError;
      expect(b.url).toBe('chrome://settings');
      expect(b.reason).toBe('internal-scheme');
      expect(b.message).toContain('Refusing');
      expect(b.name).toBe('BlockedUrlError');
    }
  });
});

describe('policyRegistry', () => {
  beforeEach(() => {
    resetActivePolicy();
  });

  it('starts at DEFAULT_POLICY', () => {
    const p = getActivePolicy();
    expect(p.blockInternal).toBe(DEFAULT_POLICY.blockInternal);
    expect(p.blockFile).toBe(DEFAULT_POLICY.blockFile);
    expect(p.blockDangerousExtensions).toBe(DEFAULT_POLICY.blockDangerousExtensions);
  });

  it('default policy is permissive on internal URLs', () => {
    // Confirms the decision: only file:// and executable docs are blocked
    // by default. chrome:// and devtools:// are not.
    expect(DEFAULT_POLICY.blockInternal).toBe(false);
    expect(DEFAULT_POLICY.blockFile).toBe(true);
    expect(DEFAULT_POLICY.blockDangerousExtensions).toBe(true);
  });

  it('setActivePolicy replaces and getActivePolicy returns a defensive copy', () => {
    setActivePolicy({ ...DEFAULT_POLICY, domainAllowlist: ['a.com'] });
    const p1 = getActivePolicy();
    expect(p1.domainAllowlist).toEqual(['a.com']);

    p1.domainAllowlist!.push('b.com');
    const p2 = getActivePolicy();
    expect(p2.domainAllowlist).toEqual(['a.com']);
  });

  it('resetActivePolicy restores defaults', () => {
    setActivePolicy({ blockInternal: false, blockFile: false, blockDangerousExtensions: false });
    resetActivePolicy();
    expect(getActivePolicy().blockInternal).toBe(false);
    expect(getActivePolicy().blockFile).toBe(true);
  });
});

describe('normalizePolicy', () => {
  it('fills in defaults for missing boolean flags', () => {
    const p = normalizePolicy({ domainAllowlist: ['x.com'] });
    expect(p.blockInternal).toBe(false);
    expect(p.blockFile).toBe(true);
    expect(p.blockDangerousExtensions).toBe(true);
    expect(p.domainAllowlist).toEqual(['x.com']);
  });

  it('honors explicit overrides', () => {
    const p = normalizePolicy({ blockInternal: true, blockFile: false });
    expect(p.blockInternal).toBe(true);
    expect(p.blockFile).toBe(false);
  });

  it('drops unknown keys', () => {
    const p = normalizePolicy({ blockInternal: false, totallyMadeUp: 42 } as Record<string, unknown>);
    expect(p.blockInternal).toBe(false);
    expect((p as Record<string, unknown>).totallyMadeUp).toBeUndefined();
  });

  it('returns defaults for non-object input', () => {
    expect(normalizePolicy(null)).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy('garbage')).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy(42)).toEqual(DEFAULT_POLICY);
  });

  it('rejects non-string entries in allow/deny lists', () => {
    const p = normalizePolicy({
      domainAllowlist: ['a.com', 42, 'b.com', null, 'c.com'],
    });
    expect(p.domainAllowlist).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('omits allow/deny lists when not arrays', () => {
    const p = normalizePolicy({ domainAllowlist: 'not an array' });
    expect(p.domainAllowlist).toBeUndefined();
  });
});

describe('resolvePolicyPath + loadPolicyFromFile', () => {
  const origEnv = process.env.COMET_URL_POLICY;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.COMET_URL_POLICY;
    else process.env.COMET_URL_POLICY = origEnv;
  });

  it('prefers $COMET_URL_POLICY over ~/.comet-mcp/url-policy.json', () => {
    const envPath = path.resolve('/etc/comet/policy.json');
    process.env.COMET_URL_POLICY = envPath;
    expect(resolvePolicyPath(process.env, '/home/test', () => true)).toBe(envPath);
  });

  it('loadPolicyFromFile parses valid JSON', () => {
    const json = JSON.stringify({
      blockInternal: false,
      domainAllowlist: ['*.mycompany.com'],
    });
    const p = loadPolicyFromFile('/whatever.json', () => json);
    expect(p.blockInternal).toBe(false);
    expect(p.blockFile).toBe(true);
    expect(p.domainAllowlist).toEqual(['*.mycompany.com']);
  });

  it('loadPolicyFromFile throws on malformed JSON', () => {
    expect(() => loadPolicyFromFile('/x.json', () => '{ broken')).toThrow();
  });
});
