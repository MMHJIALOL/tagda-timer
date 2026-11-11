import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('vendor/gan', { recursive: true });
await build({ stdin: { contents: "export { connectGanCube, cubeTimestampLinearFit } from 'gan-web-bluetooth';", resolveDir: process.cwd() }, outfile: 'vendor/gan/gan-3.0.2.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline' });
const notices = await Promise.all(['gan-web-bluetooth', 'rxjs', 'aes-js'].map(async name => `${name}\n${await readFile(`node_modules/${name}/LICENSE.txt`, 'utf8')}`));
await writeFile('vendor/gan/THIRD-PARTY-LICENSES.txt', notices.join('\n\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n');
