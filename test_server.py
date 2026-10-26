import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import server


def probe(path):
    return json.loads(subprocess.check_output([server.FFPROBE, '-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', str(path)]))


def frames(path):
    data = subprocess.check_output([server.FFMPEG, '-v', 'error', '-i', str(path), '-map', '0:v:0', '-f', 'framemd5', '-'])
    return [line.rsplit(b',', 1)[1].strip() for line in data.splitlines() if line and not line.startswith(b'#')]


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='cutroom-test-')
        cls.root = Path(cls.temp.name)
        cls.source = cls.root / 'source.mp4'
        subprocess.run([server.FFMPEG, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', '-c:v', 'libx264', '-g', '120', '-keyint_min', '120', '-sc_threshold', '0', '-c:a', 'aac', str(cls.source)], check=True)
        cls.original = probe(cls.source)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_preserves_encoded_video_audio_and_60fps(self):
        source_frames = frames(self.source)
        for start, end, name in [(2, 4, 'safe.mp4'), (2.61, 3.51, 'unsafe.mp4'), (0, 5, 'full.mp4')]:
            with self.subTest(start=start):
                output = self.root / name
                server.clip(self.source, output, start, end, threading.Event())
                result = probe(output)
                self.assertEqual(len(result['streams']), 2)
                for original, clipped in zip(self.original['streams'], result['streams']):
                    for field in ['codec_name', 'width', 'height', 'pix_fmt', 'r_frame_rate', 'sample_rate', 'channels']:
                        self.assertEqual(original.get(field), clipped.get(field), field)
                self.assertEqual(result['streams'][0]['r_frame_rate'], '60/1')
                for index in [0, 1]:
                    hashes = [p['data_hash'] for p in self.original['packets'] if p['stream_index'] == index]
                    packets = [p for p in result['packets'] if p['stream_index'] == index]
                    self.assertTrue(packets)
                    copied = [p['data_hash'] for p in packets]
                    offset = hashes.index(copied[0])
                    self.assertEqual(copied, hashes[offset:offset + len(copied)])
                self.assertIn('K', next(p for p in result['packets'] if p['stream_index'] == 0)['flags'])
                clipped_frames = frames(output)
                self.assertTrue(clipped_frames)
                # The final reordered reference frame can lie beyond the cut.
                # Packets above must still be an exact contiguous source slice.
                indices = [source_frames.index(frame) for frame in clipped_frames]
                self.assertEqual(indices, sorted(set(indices)))
                subprocess.run([server.FFMPEG, '-v', 'error', '-xerror', '-i', str(output), '-f', 'null', '-'], check=True, capture_output=True)

    def test_silent_video(self):
        source = self.root / 'silent.mp4'
        subprocess.run([server.FFMPEG, '-v', 'error', '-i', str(self.source), '-an', '-c', 'copy', str(source)], check=True)
        output = self.root / 'silent-clip.mp4'
        server.clip(source, output, .7, 2.1, threading.Event())
        self.assertEqual(len(probe(output)['streams']), 1)

    def test_crop_dimensions_audio_and_location(self):
        output = self.root / 'cropped.mp4'
        server.clip(self.source, output, 0, 1, threading.Event(), [.25, .2, .5, .6])
        result = probe(output)
        video = result['streams'][0]
        self.assertEqual((video['width'], video['height']), (160, 108))
        self.assertEqual(video['r_frame_rate'], '60/1')
        self.assertEqual(result['streams'][1]['codec_name'], 'aac')
        # Compare decoded pixels to an independent reference crop, allowing H.264 loss.
        def pixels(path, filters):
            return subprocess.check_output([server.FFMPEG, '-v', 'error', '-i', str(path),
                '-vf', filters, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
        expected = pixels(self.source, 'crop=160:108:80:36')
        actual = pixels(output, 'null')
        self.assertEqual(len(expected), len(actual))
        self.assertLess(sum(abs(a-b) for a,b in zip(expected, actual))/len(actual), 5)

    def test_rotated_crop(self):
        source = self.root / 'rotated.mp4'
        subprocess.run([server.FFMPEG, '-v', 'error', '-display_rotation', '90', '-i', str(self.source),
                        '-c', 'copy', str(source)], check=True)
        output = self.root / 'rotated-crop.mp4'
        server.clip(source, output, .5, 1.5, threading.Event(), [0, .25, 1, .5])
        stream = probe(output)['streams'][0]
        self.assertEqual((stream['width'], stream['height']), (180, 160))
        self.assertFalse(any(d.get('rotation', 0) for d in stream.get('side_data_list', [])))

    def test_invalid_crop(self):
        for crop in [[-1, 0, 1, 1], [0, 0, 0, 1], [.5, 0, 1, 1], [0, 0, float('nan'), 1],
                     [0, 0, .001, 1], {}, [True, 0, 1, 1]]:
            with self.subTest(crop=crop), self.assertRaises(ValueError):
                server.clip(self.source, self.root / 'invalid-crop.mp4', 0, 1, threading.Event(), crop)

    def test_precise_time_range_with_and_without_crop(self):
        for crop in [None, [.25, .2, .5, .6]]:
            with self.subTest(crop=crop):
                output = self.root / 'precise.mp4'
                server.clip(self.source, output, 2.6, 3.6, threading.Event(), crop, precise=True)
                result = probe(output)
                for stream in result['streams']:
                    self.assertAlmostEqual(float(stream['start_time']), 0, delta=.025)
                    self.assertAlmostEqual(float(stream['duration']), 1, delta=.035)
                # Verify the first displayed frame is from 2.6 seconds, not a keyframe before it.
                filters = 'crop=160:108:80:36' if crop else 'null'
                expected = subprocess.check_output([server.FFMPEG, '-v', 'error', '-ss', '2.6',
                    '-i', str(self.source), '-vf', filters, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
                actual = subprocess.check_output([server.FFMPEG, '-v', 'error', '-i', str(output),
                    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
                self.assertEqual(len(expected), len(actual))
                self.assertLess(sum(abs(a-b) for a,b in zip(expected, actual))/len(actual), 5)

    def test_out_of_bounds(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            server.clip(self.source, self.root / 'bad.mp4', 10, 12, threading.Event())

    def test_cancelled(self):
        cancelled = threading.Event(); cancelled.set()
        with self.assertRaisesRegex(ValueError, 'cancelled'):
            server.clip(self.source, self.root / 'cancelled.mp4', 0, 1, cancelled)

    def test_corrupt_source(self):
        source = self.root / 'broken'; source.write_bytes(b'not a video')
        with self.assertRaisesRegex(ValueError, 'No quality-reducing conversion'):
            server.clip(source, self.root / 'bad.mp4', 0, 1, threading.Event())


if __name__ == '__main__':
    unittest.main()
