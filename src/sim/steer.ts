/**
 * The sim turns left for positive `InputFrame.steer` (heading grows counter-clockwise seen from the
 * chase camera). Player devices report right as positive, so they must pass through this once.
 * CPU input comes from getAIInput, which already speaks the sim convention.
 */
export function playerSteerToSim(rightPositive: number): number {
  return rightPositive === 0 ? 0 : -rightPositive;
}
