// Régénère les petits fichiers vidéo de tests/fixtures (démultiplexeur des miniatures). Usage :
//   node tools/gen-thumb-fixtures.mjs [chemin/vers/ffmpeg]
// Images clés toutes les 2 s exactement (-g 50 à 25 i/s), pas de détection de scène.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.argv[2] ?? 'C:/Users/grego/Projets/laststream/dist/laststream-desktop/ffmpeg.exe';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
mkdirSync(out, { recursive: true });

const h264Src = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10'];
const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '24k', '-ac', '1', '-ar', '22050'];
const hevcSrc = ['-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=25:duration=6'];
const hevc = ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '34', '-x265-params', 'keyint=50:min-keyint=50:scenecut=0:log-level=error', '-pix_fmt', 'yuv420p'];

const jobs = [
  [h264Src, h264, 'h264.mp4'], // moov en fin de fichier
  [h264Src, [...h264, '-movflags', '+faststart'], 'h264-faststart.mp4'], // moov au début
  [h264Src, h264, 'h264.mkv'],
  [hevcSrc, [...hevc, '-tag:v', 'hvc1'], 'hevc.mp4'],
  [hevcSrc, hevc, 'hevc.mkv'],
];
for (const [src, enc, name] of jobs) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...src, ...enc, join(out, name)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg a échoué pour ${name}`);
  console.log('ok', name);
}
