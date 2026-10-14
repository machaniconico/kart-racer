import { describe, expect, it } from 'vitest';
import { getTrack } from './index';

describe('MEADOW course', () => {
  it('pins its layout version', () => {
    expect(getTrack('meadow').def.layoutVersion).toBe(2);
  });
});
