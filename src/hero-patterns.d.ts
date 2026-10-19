// hero-patterns ships no types. Each pattern is a function returning a CSS `url(...)` of an SVG tile.
declare module 'hero-patterns' {
  type Pattern = (fill?: string, opacity?: number) => string;
  export const circuitBoard: Pattern;
  export const wiggle: Pattern;
  export const hexagons: Pattern;
  export const graphPaper: Pattern;
}
