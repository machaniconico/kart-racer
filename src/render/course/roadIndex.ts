import { rollAt, sampleTrack, surfaceHeightAt, wrapDistance } from '../../sim';
import type { Track, TrackSample } from '../../sim';
import { widthAt } from '../../sim/corridor';

const CELL_SIZE = 32;
const MAX_MARGIN = 22;

function maxWallHalfWidth(track: Track): number {
  return Math.max(track.def.wallHalfWidth, ...(track.def.widthKeys ?? []).map(key => key.wallHalfWidth));
}

/** Keep the reference arithmetic, including signed zero on unbanked roads. */
function pointHeight(track: Track, point: TrackSample, offset: number): number {
  return rollAt(track, point.distance) === 0 ? point.y : surfaceHeightAt(track, point.distance, offset);
}

/** Conservative XZ candidates, in original segment order for first-wins ties. */
export class RoadIndex {
  private readonly cells = new Map<number, Map<number, number[]>>();

  constructor(private readonly track: Track) {
    const padding = maxWallHalfWidth(track) + MAX_MARGIN + 1e-6;
    for (let i = 0; i < track.samples.length; i++) {
      const a = track.samples[i], b = track.samples[(i + 1) % track.samples.length];
      const minX = Math.floor((Math.min(a.x, b.x) - padding) / CELL_SIZE);
      const maxX = Math.floor((Math.max(a.x, b.x) + padding) / CELL_SIZE);
      const minZ = Math.floor((Math.min(a.z, b.z) - padding) / CELL_SIZE);
      const maxZ = Math.floor((Math.max(a.z, b.z) + padding) / CELL_SIZE);
      for (let x = minX; x <= maxX; x++) {
        let column = this.cells.get(x);
        if (!column) this.cells.set(x, column = new Map());
        for (let z = minZ; z <= maxZ; z++) {
          const candidates = column.get(z);
          if (candidates) candidates.push(i);
          else column.set(z, [i]);
        }
      }
    }
  }

  heightAt(x: number, z: number, deck: boolean, margin = 0, ceiling = Infinity): number | undefined {
    if (margin > MAX_MARGIN) throw new RangeError(`RoadIndex margin must be at most ${MAX_MARGIN}`);
    const candidates = this.cells.get(Math.floor(x / CELL_SIZE))?.get(Math.floor(z / CELL_SIZE));
    if (!candidates) return undefined;
    const track = this.track;
    let height: number | undefined;
    let nearestSquared = Infinity;
    for (const i of candidates) {
      const a = track.samples[i], b = track.samples[(i + 1) % track.samples.length];
      const dx = b.x - a.x, dz = b.z - a.z;
      const lengthSquared = dx * dx + dz * dz;
      if (lengthSquared === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
      const d = a.distance + t * ((i + 1 === track.samples.length ? track.length : b.distance) - a.distance);
      if (Boolean(track.def.decks?.some(span => {
        const distance = wrapDistance(track, d);
        return span.from <= span.to ? distance >= span.from && distance < span.to
          : distance >= span.from || distance < span.to;
      })) !== deck) continue;
      const half = widthAt(track, d).wallHalfWidth + margin;
      const squared = (x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2;
      if (squared > half * half + 1e-8 || squared >= nearestSquared) continue;
      const point = sampleTrack(track, d);
      const offset = (x - point.x) * point.nx + (z - point.z) * point.nz;
      const y = pointHeight(track, point, offset);
      if (y >= ceiling) continue;
      nearestSquared = squared;
      height = y;
    }
    return height;
  }
}
