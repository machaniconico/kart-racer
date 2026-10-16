import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTrack, projectToTrack, sampleTrack } from '../../sim';
import type { TrackId } from '../../sim';
import { TRACK_IDS } from '../../sim/tracks';
import { buildCourse, roadHeightAtXZReference } from './buildCourse';
import { RoadIndex } from './roadIndex';
import { neon } from './themes/neon';

// M9-01 benchmark: five warmed buildCourse(neon) wall times per implementation.
// 2026-10-15, darwin-arm64, Node 25.8.1 / Vitest 4.1.11, two warmups each:
// indexed median 33.911 ms / reference median 179.301 ms = 18.91%.
// The reference run restores the exhaustive lookup through heightAt; both runs
// include index construction and exclude disposal. Timings are reported, not asserted.
// Full 8 * 20,000 * 2 * 3 * 2 = 1,920,000 Object.is comparisons: 22.385 s.

// Each worker receives the real production modules bundled in memory. This
// avoids Vitest module-wrapper overhead in the 1.92 million exhaustive scans,
// runs courses in parallel, and writes no extra fixture/build files.
function compareCourse({ id, from }: { id: TrackId; from: number }, api: {
  getTrack: typeof getTrack; projectToTrack: typeof projectToTrack; sampleTrack: typeof sampleTrack;
  RoadIndex: typeof RoadIndex; roadHeightAtXZReference: typeof roadHeightAtXZReference;
}): number {
  const { getTrack, projectToTrack, sampleTrack, RoadIndex, roadHeightAtXZReference } = api;
  let seed = 9;
  const random = (): number => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
  for (let i = 0; i < from * 2; i++) random();
  const track = getTrack(id);
  const index = new RoadIndex(track);
  // Only the oracle gets a mutable, value-identical fixture so V8 can optimize
  // its full scan. structuredClone preserves all numbers, including signed zero.
  const referenceTrack = structuredClone(track);
  const minX = Math.min(...track.samples.map(point => point.x)) - 30;
  const maxX = Math.max(...track.samples.map(point => point.x)) + 30;
  const minZ = Math.min(...track.samples.map(point => point.z)) - 30;
  const maxZ = Math.max(...track.samples.map(point => point.z)) + 30;
  const queries: { x: number; z: number; ceiling: number }[] = [];
  const heights: (number | undefined)[] = [];
  for (let i = from; i < from + 1_000; i++) {
    const x = minX + random() * (maxX - minX);
    const z = minZ + random() * (maxZ - minZ);
    const ceiling = sampleTrack(track, projectToTrack(track, x, z).distance).y - 0.6;
    queries.push({ x, z, ceiling });
    for (const deck of [true, false]) {
      for (const margin of [0, 0.45, 22]) {
        for (const limit of [Infinity, ceiling]) heights.push(index.heightAt(x, z, deck, margin, limit));
      }
    }
  }
  // Every query calls the unchanged oracle, including both ceiling choices.
  let comparisons = 0;
  for (const [i, { x, z, ceiling }] of queries.entries()) {
    for (const deck of [true, false]) {
      for (const margin of [0, 0.45, 22]) {
        for (const limit of [Infinity, ceiling]) {
          const actual = heights[comparisons];
          const expected = roadHeightAtXZReference(referenceTrack, x, z, deck, margin, limit);
          if (!Object.is(actual, expected)) {
            throw new Error(`${id} point ${from + i}: (${x}, ${z}), deck=${deck}, margin=${margin}, ceiling=${limit}: ${actual} !== ${expected}`);
          }
          comparisons++;
        }
      }
    }
  }
  return comparisons;
}

beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({
      fillRect() {}, fillText() {},
    }) }),
  });
});
afterAll(() => vi.unstubAllGlobals());

describe('RoadIndex', () => {
  it('reports five-build neon medians with indexed and restored reference lookups', () => {
    const track = getTrack('neon');
    const indexed = RoadIndex.prototype.heightAt;
    const reference: typeof indexed = (x, z, deck, margin, ceiling) =>
      roadHeightAtXZReference(track, x, z, deck, margin, ceiling);
    const timings = { indexed: [] as number[], reference: [] as number[] };
    const measure = (lookup: typeof indexed): number => {
      RoadIndex.prototype.heightAt = lookup;
      const started = performance.now();
      const course = buildCourse(track, neon);
      const elapsed = performance.now() - started;
      course.dispose();
      return elapsed;
    };
    try {
      for (let i = 0; i < 2; i++) {
        measure(indexed);
        measure(reference);
      }
      for (let i = 0; i < 5; i++) {
        // Alternate order to distribute JIT/GC and thermal drift between modes.
        for (const mode of i % 2 ? ['reference', 'indexed'] as const : ['indexed', 'reference'] as const) {
          timings[mode].push(measure(mode === 'indexed' ? indexed : reference));
        }
      }
    } finally {
      RoadIndex.prototype.heightAt = indexed;
    }
    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[2];
    console.info('M9-01 neon buildCourse', JSON.stringify({
      machine: `${process.platform}-${process.arch}`, runs: timings,
      indexedMedianMs: median(timings.indexed), referenceMedianMs: median(timings.reference),
      ratio: median(timings.indexed) / median(timings.reference),
    }));
  });

  it('matches every course at 20,000 seeded XZ points each, bit-for-bit', async ({ onTestFinished }) => {
    const jobs = Array.from({ length: 20 }, (_, i) => i * 1_000)
      .flatMap(from => TRACK_IDS.map(id => ({ id, from })));
    const workers: Worker[] = [];
    const counts: number[] = [];
    let next = 0;
    let stopped = false;
    onTestFinished(async () => {
      stopped = true;
      next = jobs.length;
      await Promise.all(workers.map(worker => worker.terminate()));
    });
    const bundle = await build({
      stdin: {
        contents: `export { getTrack, projectToTrack, sampleTrack } from './src/sim';
          export { RoadIndex } from './src/render/course/roadIndex';
          export { roadHeightAtXZReference } from './src/render/course/buildCourse';`,
        resolveDir: process.cwd(),
      },
      bundle: true, write: false, platform: 'node', format: 'cjs',
    });
    if (stopped) return;
    const source = `${bundle.outputFiles[0].text}
      const { parentPort } = require('node:worker_threads');
      // Give the exhaustive oracle its own helpers and JIT feedback, so frozen
      // production inputs do not slow its value-identical mutable fixtures.
      const oracle = { exports: {} };
      new Function('module', 'exports', 'require', ${JSON.stringify(bundle.outputFiles[0].text)})(oracle, oracle.exports, require);
      const api = { ...module.exports, roadHeightAtXZReference: oracle.exports.roadHeightAtXZReference };
      const compare = ${compareCourse.toString()};
      parentPort.on('message', job => parentPort.postMessage(compare(job, api)));`;
    for (let i = 0; i < Math.min(availableParallelism(), 8, jobs.length); i++) {
      workers.push(new Worker(source, { eval: true }));
    }
    await Promise.all(workers.map(async worker => {
      const failure = new Promise<never>((_, reject) => {
        worker.once('error', reject);
        worker.once('exit', code => reject(new Error(`RoadIndex worker exited ${code} before returning a result`)));
      });
      while (next < jobs.length) {
        const result = new Promise<number>(resolve => worker.once('message', resolve));
        worker.postMessage(jobs[next++]);
        counts.push(await Promise.race([result, failure]));
      }
    }));
    expect(counts).toEqual(jobs.map(() => 12_000));
  }, 600_000); // 16 courses since M10: ~120 s on CI ubuntu-latest exceeded the old 120 s

  it.each(TRACK_IDS)('%s also matches frozen oracle inputs at seams, deck ends and cell edges', id => {
    const track = getTrack(id);
    const referenceTrack = structuredClone(track);
    expect(referenceTrack).toEqual(track);
    const index = new RoadIndex(track);
    const distances = [0, track.samples.at(-1)!.distance,
      ...(track.def.decks ?? []).flatMap(span => [span.from - 1e-6, span.from, span.from + 1e-6,
        span.to - 1e-6, span.to, span.to + 1e-6])];
    for (const distance of distances) {
      const point = sampleTrack(track, distance);
      const edge = Math.round(point.x / 32) * 32;
      for (const x of [point.x, edge - 1e-7, edge, edge + 1e-7]) {
        for (const deck of [true, false]) {
          for (const margin of [0, 0.45, 22]) {
            const height = roadHeightAtXZReference(track, x, point.z, deck, margin);
            for (const ceiling of [Infinity, height ?? point.y, (height ?? point.y) - 0.6]) {
              const expected = roadHeightAtXZReference(track, x, point.z, deck, margin, ceiling);
              expect(Object.is(index.heightAt(x, point.z, deck, margin, ceiling), expected)).toBe(true);
              expect(Object.is(roadHeightAtXZReference(referenceTrack, x, point.z, deck, margin, ceiling), expected)).toBe(true);
            }
          }
        }
      }
    }
  });

  it('rejects margins beyond the indexed halo even outside occupied cells', () => {
    const index = new RoadIndex(getTrack('neon'));
    for (const margin of [22 + 1e-6, 23, Infinity]) {
      expect(() => index.heightAt(0, 0, false, margin)).toThrow(RangeError);
      expect(() => index.heightAt(1e9, 1e9, true, margin)).toThrow(RangeError);
    }
    expect(index.heightAt(1e9, 1e9, false, 22)).toBeUndefined();
  });
});
