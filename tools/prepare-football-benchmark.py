"""Download a bounded evaluation sample from the official SoccerNet archive.

No complete multi-GB archive is downloaded. Frames/labels stay outside Git.
Official training-partition samples are reference evaluation data, not a claim
of unseen test performance or permission to redistribute or train commercially.
"""
import argparse
import configparser
import hashlib
import json
import struct
import threading
from pathlib import Path
import urllib.request
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor


class RangeArchive:
    def __init__(self, url, size, cache, budget=128*1024*1024):
        self.url, self.size, self.cache = url, size, cache
        self.position = self.downloaded = 0
        self.budget = budget
        self.lock = threading.Lock()
        cache.mkdir(parents=True, exist_ok=True)

    def seek(self, offset, whence=0):
        self.position = (0 if whence == 0 else self.position if whence == 1 else self.size) + offset
        return self.position

    def tell(self): return self.position
    def seekable(self): return True

    def read(self, count=-1):
        count = self.size-self.position if count < 0 else min(count, self.size-self.position)
        data = self.read_at(self.position, count)
        self.position += len(data)
        return data

    def read_at(self, start, count):
        count = min(count, self.size-start)
        if count <= 0: return b''
        if count > 16*1024*1024: raise RuntimeError('Refusing an unbounded archive read')
        end = start+count-1
        cached = self.cache / f'{start}-{end}.bin'
        if cached.exists():
            data = cached.read_bytes()
        else:
            with self.lock:
                if self.downloaded+count > self.budget: raise RuntimeError('Sample download budget reached')
                self.downloaded += count
            req = urllib.request.Request(self.url, headers={'Range': f'bytes={start}-{end}'})
            with urllib.request.urlopen(req, timeout=90) as response:
                if response.status != 206: raise RuntimeError('Server did not honor bounded download')
                content_range = response.headers.get('Content-Range', '')
                if not content_range.startswith(f'bytes {start}-{end}/'):
                    raise RuntimeError('Archive returned a different byte interval')
                data = response.read(count)
            if len(data) != count: raise RuntimeError('Truncated benchmark archive interval')
            cached.write_bytes(data)
        return data

    def member(self, info):
        if info.file_size > 8*1024*1024: raise RuntimeError('Unexpected benchmark member size')
        # One bounded request includes header, optional extra fields and data.
        # This avoids three network round trips for every individual frame.
        data = self.read_at(info.header_offset, info.compress_size+65566+len(info.filename.encode('utf-8')))
        if data[:4] != b'PK\x03\x04': raise RuntimeError('Invalid local ZIP header')
        method = struct.unpack_from('<H', data, 8)[0]
        name_size, extra_size = struct.unpack_from('<HH', data, 26)
        offset = 30+name_size+extra_size
        packed = data[offset:offset+info.compress_size]
        result = zlib.decompress(packed, -15) if method == 8 else packed if method == 0 else None
        if result is None or len(result) != info.file_size or zlib.crc32(result) & 0xffffffff != info.CRC:
            raise RuntimeError('Benchmark member checksum failed')
        return result


def prepare(output, sequences=12, frames=6):
    output.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen('https://huggingface.co/api/datasets/SoccerNet/SN-Tracking-2023', timeout=30) as r:
        repository = json.load(r)
    revision = repository['sha']
    with urllib.request.urlopen(f'https://huggingface.co/api/datasets/SoccerNet/SN-Tracking-2023/tree/{revision}', timeout=30) as r:
        entry = next(item for item in json.load(r) if item['path'] == 'train.zip')
    url = f'https://huggingface.co/datasets/SoccerNet/SN-Tracking-2023/resolve/{revision}/train.zip'
    archive = RangeArchive(url, entry['size'], output/'range-cache'/revision)
    manifest = {'version': 1, 'dataset': 'SoccerNet/SN-Tracking-2023', 'revision': revision,
                'officialPartition': 'train', 'use': 'reference_evaluation_only',
                'pretrainingOverlap': 'unknown', 'sequences': [], 'frames': []}
    with zipfile.ZipFile(archive) as z:
        prefixes = sorted(name[:-len('gameinfo.ini')] for name in z.namelist() if name.endswith('/gameinfo.ini'))
        count = min(sequences, len(prefixes))
        selected = [prefixes[round(i*(len(prefixes)-1)/max(1, count-1))] for i in range(count)]
        for prefix in selected:
            name = prefix.rstrip('/').split('/')[-1]
            if not name.startswith('SNMOT-') or not name[6:].isdigit(): raise RuntimeError('Invalid sequence path')
            folder = output/name
            folder.mkdir(exist_ok=True)
            texts = {}
            for relative in ['gameinfo.ini', 'seqinfo.ini', 'gt/gt.txt']:
                data = archive.member(z.getinfo(prefix+relative))
                (folder/relative.replace('/', '-')).write_bytes(data)
                texts[relative] = data.decode('utf-8-sig')
            game, seq = configparser.ConfigParser(), configparser.ConfigParser()
            game.read_string(texts['gameinfo.ini']); seq.read_string(texts['seqinfo.ini'])
            game, seq = game['Sequence'], seq['Sequence']
            ball_ids = {int(key.split('_')[1]) for key, value in game.items()
                        if key.startswith('trackletid_') and value.split(';')[0].strip() == 'ball'}
            by_frame = {}
            for row in texts['gt/gt.txt'].splitlines():
                values = row.split(',')
                if len(values) >= 7 and int(values[1]) in ball_ids:
                    by_frame.setdefault(int(values[0]), []).append([float(v) for v in values[2:6]])
            length = int(seq['seqLength'])
            chosen = sorted({round(1+i*(length-1)/max(1, frames-1)) for i in range(frames)})
            manifest['sequences'].append({'id': name, 'matchGroup': f"soccernet-game-{game['gameID']}",
                'actionClass': game.get('actionClass'), 'ballTrackIds': sorted(ball_ids),
                'fps': int(seq['frameRate']), 'length': length})
            def fetch_frame(frame):
                filename = f'{frame:06d}.jpg'
                info = z.getinfo(prefix+'img1/'+filename)
                if info.file_size > 8*1024*1024: raise RuntimeError('Unexpected image size')
                data = archive.member(info)
                target = folder/filename
                target.write_bytes(data)
                return {'sequence': name, 'frame': frame,
                    'image': f'{name}/{filename}', 'sha256': hashlib.sha256(data).hexdigest(),
                    'width': int(seq['imWidth']), 'height': int(seq['imHeight']),
                    'ballBoxesXYWH': by_frame.get(frame, []),
                    'ballReferenceAvailable': bool(by_frame.get(frame))}
            with ThreadPoolExecutor(max_workers=4) as executor:
                manifest['frames'].extend(executor.map(fetch_frame, chosen))
            manifest['downloadedBytes'] = archive.downloaded
            (output/'manifest.json').write_text(json.dumps(manifest, indent=2))
            print(json.dumps({'sequence': name, 'action': game.get('actionClass'),
                              'frames': len(chosen), 'downloadedBytes': archive.downloaded}), flush=True)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sequences', type=int, default=12)
    parser.add_argument('--frames', type=int, default=6)
    args = parser.parse_args()
    if not 1 <= args.sequences <= 30 or not 2 <= args.frames <= 20: parser.error('Sample limits exceeded')
    result = prepare(args.output, args.sequences, args.frames)
    print(json.dumps({'sequences': len(result['sequences']), 'frames': len(result['frames']),
                      'matches': len({s['matchGroup'] for s in result['sequences']})}))
