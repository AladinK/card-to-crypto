/** Minimal static pages shown to the browser. No user input is interpolated into them. */
export function pageHtml(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; line-height: 1.5; color: #1a1a1a; }
main { max-width: 520px; margin: 48px auto; }
h1 { font-size: 1.4rem; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${message}</p>
</main>
</body>
</html>
`;
}
