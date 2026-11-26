import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./catalog-build.mjs', import.meta.url));
const approved = '1.1.0-pta1010.1';
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinta-stage-catalog-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(source, path.join(root, 'scripts/catalog-build.mjs'));
  fs.mkdirSync(path.join(root, 'catalog/fixture'), { recursive: true });
  for (const version of ['1.0.0', approved, '9.0.0-rc.1']) {
    fs.writeFileSync(path.join(root, `catalog/fixture/${version}.yaml`), JSON.stringify({
      schema_version: 1, id: 'fixture', version,
      artifact: { url: 'https://example.invalid/fixture.tgz', sha256: 'a'.repeat(64) },
    }));
  }
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function config(overrides = {}) {
  fs.writeFileSync(path.join(root, 'catalog.config.json'), JSON.stringify({
    expectedSchemaVersion: 1,
    oldestSupportedFloorBlind: null,
    manifestFloors: { fixture: { [approved]: '0.2.2', '9.0.0-rc.1': '0.2.2' } },
    stageVersions: { fixture: approved },
    ...overrides,
  }));
}

function run(...args) {
  return spawnSync(process.execPath, ['scripts/catalog-build.mjs', ...args], {
    cwd: root, encoding: 'utf8',
  });
}

function index() {
  return JSON.parse(fs.readFileSync(path.join(root, 'catalog/index.json'), 'utf8'));
}

describe('catalog-approved Stage versions', () => {
  it('generates an explicit approval without promoting prereleases to floor-blind latest', () => {
    config({ oldestSupportedFloorBlind: '0.3.0' });
    expect(run().status).toBe(0);
    expect(index().adaptors[0]).toMatchObject({ latest: '1.0.0', stageVersion: approved });
    expect(run('--check').status).toBe(0);
  });

  it('detects a stale approval and preserves the generation timestamp when unchanged', () => {
    config();
    expect(run().status).toBe(0);
    const first = index();
    expect(run().status).toBe(0);
    expect(index().generated).toBe(first.generated);
    config({ stageVersions: { fixture: '9.0.0-rc.1' } });
    expect(run('--check').status).toBe(1);
    expect(run().status).toBe(0);
    expect(index().adaptors[0].stageVersion).toBe('9.0.0-rc.1');
  });

  it('removes an approval without changing stable latest or manifest bytes', () => {
    config();
    expect(run().status).toBe(0);
    const before = fs.readFileSync(path.join(root, `catalog/fixture/${approved}.yaml`));
    config({ stageVersions: {} });
    expect(run().status).toBe(0);
    expect(index().adaptors[0].latest).toBe('1.0.0');
    expect(index().adaptors[0]).not.toHaveProperty('stageVersion');
    expect(fs.readFileSync(path.join(root, `catalog/fixture/${approved}.yaml`))).toEqual(before);
  });

  it.each([
    { stageVersions: { missing: approved } },
    { stageVersions: { fixture: '1.2.0-rc.1' } },
    { stageVersions: { fixture: 'not-a-version' } },
    { stageVersions: { fixture: '1.0.0' } },
    { manifestFloors: {} },
    { stageVersions: [] },
    { stageVersions: 'invalid' },
  ])('rejects an invalid Stage approval without writing an index', (override) => {
    config(override);
    expect(run().status).toBe(1);
    expect(fs.existsSync(path.join(root, 'catalog/index.json'))).toBe(false);
  });
});
