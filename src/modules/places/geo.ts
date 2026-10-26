/** Geometry helpers: distances, Swiss coordinates and polygons. */

export interface Point {
  lat: number;
  lon: number;
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Swiss LV95 coordinates (east, north, e.g. 2600000 / 1200000) to WGS84, with
 * swisstopo's approximate formulas (accurate to about a metre).
 */
export function lv95ToWgs84(east: number, north: number): Point {
  const y = (east - 2_600_000) / 1_000_000;
  const x = (north - 1_200_000) / 1_000_000;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat =
    16.9023892 +
    3.238272 * x -
    0.270978 * y * y -
    0.002528 * x * x -
    0.0447 * y * y * x -
    0.014 * x * x * x;
  return { lat: (lat * 100) / 36, lon: (lon * 100) / 36 };
}

/** Ray casting on one ring of [lon, lat] pairs. */
function inRing(point: Point, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi = 0, yi = 0] = ring[i] ?? [];
    const [xj = 0, yj = 0] = ring[j] ?? [];
    if (
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export type Geometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

/** Whether a point lies in a GeoJSON polygon (holes respected) or multipolygon. */
export function contains(geometry: Geometry, point: Point): boolean {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(
    ([outer, ...holes]) =>
      !!outer && inRing(point, outer) && !holes.some((hole) => inRing(point, hole)),
  );
}

/** Compass direction for a bearing in degrees: N, NE, E, ... */
export function compass(degrees: number): string {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round((((degrees % 360) + 360) % 360) / 45) % 8] ?? 'N';
}
