import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: [new URL('./app.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/, '')],
  outfile: new URL('./public/app.bundle.txt', import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/, ''),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  legalComments: 'inline',
});
const dependency = await readFile(new URL('../../node_modules/gan-web-bluetooth/LICENSE.txt', import.meta.url), 'utf8');
const rxjs = await readFile(new URL('../../node_modules/rxjs/LICENSE.txt', import.meta.url), 'utf8');
const aes = await readFile(new URL('../../node_modules/aes-js/LICENSE.txt', import.meta.url), 'utf8');
await writeFile(new URL('./public/THIRD-PARTY-LICENSES.txt', import.meta.url), `gan-web-bluetooth 3.0.2\n${dependency}\n\nRxJS\n${rxjs}\n\naes-js\n${aes}`);
