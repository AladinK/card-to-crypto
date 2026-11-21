/** Joins class names, skipping falsy values. Tailwind conflicts are avoided by how the components are written. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
