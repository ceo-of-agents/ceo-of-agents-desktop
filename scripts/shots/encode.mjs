// Turns the harness output of the media scenes into the files of docs/media:
//   node scripts/shots/encode.mjs <png-dir> <frames-dir> <out-dir> [--posters <dir>]
// <png-dir>     PNGs of the `media-*` scenes taken at scale 2 (SHOTS_SCALE=2), one per scene.
// <frames-dir>  raw frames of the scenes with a `record` setting (SHOTS_FRAMES=1, scale 1): media-<name>.frames/
// <out-dir>     where the finished files go (docs/media).
// Every file gets a 1 px border #334155 (square corners, opaque). A scene with frames becomes <name>.gif, <name>.mp4
// (H.264, yuv420p, no audio, same frames) and <name>-still.png (its last state at scale 2); the others become <name>.png.
// `--posters <dir>` also writes <name>-poster.png, the first frame of each MP4 (for a web page's video poster).
// Needs ffmpeg (with libx264) on the PATH. Nothing else is read or written.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const posterAt = args.indexOf('--posters');
const posters = posterAt >= 0 ? args.splice(posterAt, 2)[1] : null;
const [pngDir, framesDir, outDir] = args;
if (!pngDir || !framesDir || !outDir) {
  console.error('usage: node scripts/shots/encode.mjs <png-dir> <frames-dir> <out-dir> [--posters <dir>]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
if (posters) mkdirSync(posters, { recursive: true });

const BORDER = '0x334155';
const pad = (w, h) => `format=rgb24,pad=${w + 2}:${h + 2}:1:1:color=${BORDER}`;
const ffmpeg = (argv, input) =>
  new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: ['pipe', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    if (input) input(p.stdin).catch(reject);
  });

/** Writes every frame of the sequence (the picked captures, in order) to ffmpeg's stdin. */
const feed = (dir, meta) => async (stdin) => {
  let last = -1;
  let buf = null;
  for (const i of meta.sequence) {
    if (i !== last) {
      buf = readFileSync(join(dir, `${i}.bgra`));
      last = i;
    }
    if (!stdin.write(buf)) await new Promise((r) => stdin.once('drain', r));
  }
  stdin.end();
};

const raw = (meta) => ['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${meta.width}x${meta.height}`, '-framerate', String(meta.fps), '-i', '-'];

// Screenshots and stills: border, then the PNG encoder at its strongest setting (lossless, no alpha).
const png = (src, dst, w, h) => ffmpeg(['-i', src, '-vf', pad(w, h), '-frames:v', '1', '-compression_level', '9', '-pred', 'mixed', dst]);
const sizeOf = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [w, h] = r.stdout.trim().split(',').map(Number);
  return { w, h };
};

for (const file of readdirSync(pngDir).filter((f) => /^media-[a-z0-9-]+\.png$/.test(f) && !f.endsWith('-first.png'))) {
  const name = file.slice('media-'.length, -'.png'.length);
  const framesAt = join(framesDir, `media-${name}.frames`);
  const { w, h } = sizeOf(join(pngDir, file));
  if (!existsSync(framesAt)) {
    await png(join(pngDir, file), join(outDir, `${name}.png`), w, h);
    console.log(`png   ${name}.png`);
    continue;
  }
  await png(join(pngDir, file), join(outDir, `${name}-still.png`), w, h);
  console.log(`png   ${name}-still.png`);
  const meta = JSON.parse(readFileSync(join(framesAt, 'frames.json'), 'utf8'));
  const gif = `${pad(meta.width, meta.height)},split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  await ffmpeg([...raw(meta), '-vf', gif, '-loop', '0', join(outDir, `${name}.gif`)], feed(framesAt, meta));
  console.log(`gif   ${name}.gif (${meta.sequence.length} frames at ${meta.fps} fps)`);
  const mp4 = `${pad(meta.width, meta.height)},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`;
  await ffmpeg(
    [...raw(meta), '-vf', mp4, '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-r', String(meta.fps), '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', '-an', join(outDir, `${name}.mp4`)],
    feed(framesAt, meta),
  );
  console.log(`mp4   ${name}.mp4`);
  if (posters) {
    await ffmpeg(['-i', join(outDir, `${name}.mp4`), '-frames:v', '1', '-compression_level', '9', '-pred', 'mixed', join(posters, `${name}-poster.png`)]);
    console.log(`png   ${name}-poster.png`);
  }
}
