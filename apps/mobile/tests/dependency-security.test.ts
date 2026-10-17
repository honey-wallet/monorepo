/// <reference types="node" />
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Resolve through the actual consumers, so these also catch missing overrides/patches.
const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const configRequire = createRequire(expoRequire.resolve('@expo/config-plugins/package.json'));
const xcodeRequire = createRequire(configRequire.resolve('xcode/package.json'));
const routerRequire = createRequire(require.resolve('expo-router/package.json'));
const queryString = routerRequire('query-string');
const metroRequire = createRequire(require.resolve('@react-native/metro-config/package.json'));
const metroConfigRequire = createRequire(metroRequire.resolve('metro-config/package.json'));
const metroCoreRequire = createRequire(metroConfigRequire.resolve('metro/package.json'));
const fileMapRequire = createRequire(metroCoreRequire.resolve('metro-file-map/package.json'));
const micromatchRequire = createRequire(fileMapRequire.resolve('micromatch/package.json'));
const braces = micromatchRequire('braces');
const forge = cliRequire('node-forge');

describe('dependency security fixes', () => {
  it('keeps Xcode UUID generation working and rejects truncated UUID buffers', () => {
    const uuid = xcodeRequire('uuid');
    const project = configRequire('xcode').project('unused');
    project.hash = { project: { objects: {} } };
    expect(project.generateUuid()).toMatch(/^[A-F0-9]{24}$/);
    for (const name of ['v3', 'v5']) {
      for (const offset of [-1, 4]) {
        expect(() => uuid[name]('honey', uuid[name].DNS, new Uint8Array(8), offset)).toThrow(
          RangeError,
        );
      }
    }
  });

  it('preserves query decoding and handles long malformed percent-encoded input', () => {
    expect(queryString.parse('name=Honey+Wallet&plus=%2B&emoji=%F0%9F%8D%AF&tag=a&tag=b')).toEqual({
      name: 'Honey Wallet',
      plus: '+',
      emoji: '🍯',
      tag: ['a', 'b'],
    });
    for (const value of ['%FE'.repeat(10000), '%E0%A4'.repeat(10000)]) {
      expect(typeof queryString.parse(`value=${value}`).value).toBe('string');
    }
  });

  it('bounds brace and parenthesis nesting before recursive processing', () => {
    for (const [open, close] of [
      ['{', '}'],
      ['(', ')'],
      ['{(', ')}'],
    ]) {
      const depth = Math.floor(4000 / open.length);
      const pattern = `${open.repeat(depth)}x,y${close.repeat(depth)}`;
      for (const method of ['parse', 'compile', 'expand', 'stringify']) {
        expect(() => braces[method](pattern)).toThrow(/maximum depth of 128/);
      }
    }
    expect(braces.expand('src/{app,lib}/{a,b}.ts')).toEqual([
      'src/app/a.ts',
      'src/app/b.ts',
      'src/lib/a.ts',
      'src/lib/b.ts',
    ]);
    expect(braces.compile('a/{b,c}/d')).toBe('a/(b|c)/d');
    expect(braces.stringify(braces.parse('a/{b,c}/d'))).toBe('a/{b,c}/d');
    expect(braces.expand('file{1..3}')).toEqual(['file1', 'file2', 'file3']);
    expect(braces.stringify('\\{literal\\}')).toBe('{literal}');
    expect(braces.stringify('"{literal}"')).toBe('{literal}');
    expect(() => braces.parse('{'.repeat(4000))).toThrow(/maximum depth of 128/);
    const boundary = `${'{'.repeat(128)}a,b${'}'.repeat(128)}`;
    for (const method of ['parse', 'compile', 'expand', 'stringify']) {
      expect(() => braces[method](boundary)).not.toThrow();
    }
  });

  it('also bounds direct AST inputs to all recursive walkers', () => {
    type Node = { type: string; nodes: Node[] };
    const ast: Node = { type: 'root', nodes: [] };
    let node = ast;
    for (let i = 0; i < 4000; i++) {
      const child: Node = { type: 'brace', nodes: [] };
      node.nodes.push(child);
      node = child;
    }
    for (const method of ['compile', 'expand', 'stringify']) {
      expect(() => braces[method](ast)).toThrow(/maximum depth of 128/);
    }
  });

  it('rejects extra nested RSA DigestAlgorithm elements while accepting valid signatures', () => {
    const { privateKey, publicKey } = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 3 });
    const md = forge.md.sha256.create().update('Honey dependency regression');
    const digest = md.digest().getBytes();
    expect(publicKey.verify(digest, privateKey.sign(md))).toBe(true);
    expect(
      publicKey.verify(
        forge.md.sha256.create().update('tampered').digest().getBytes(),
        privateKey.sign(md),
      ),
    ).toBe(false);
    const { asn1 } = forge;
    const element = (type: number, constructed: boolean, value: unknown) =>
      asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
    for (const includeNull of [false, true]) {
      for (const extra of ['none', 'element', 'null-content']) {
        const algorithm = [
          element(asn1.Type.OID, false, asn1.oidToDer(forge.oids.sha256).getBytes()),
        ];
        if (includeNull || extra === 'null-content') {
          algorithm.push(element(asn1.Type.NULL, false, extra === 'null-content' ? 'garbage' : ''));
        }
        if (extra === 'element') algorithm.push(element(asn1.Type.OCTETSTRING, false, 'garbage'));
        const info = element(asn1.Type.SEQUENCE, true, [
          element(asn1.Type.SEQUENCE, true, algorithm),
          element(asn1.Type.OCTETSTRING, false, digest),
        ]);
        const signature = privateKey.sign(asn1.toDer(info).getBytes(), 'NONE');
        if (extra !== 'none') {
          expect(() => publicKey.verify(digest, signature)).toThrow(/DigestInfo/);
        } else {
          expect(publicKey.verify(digest, signature)).toBe(true);
        }
      }
    }
  });
});
