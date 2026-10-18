import importlib.util
import io
from pathlib import Path
import unittest
import zipfile

root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('prepare_benchmark',root/'tools'/'prepare-football-benchmark.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class FootballBenchmarkTests(unittest.TestCase):
    def test_partial_zip_reader_matches_standard_crc_checked_zip_reader(self):
        for compression in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED]:
            buffer=io.BytesIO()
            with zipfile.ZipFile(buffer,'w',compression=compression) as archive:
                archive.writestr('train/SNMOT-001/img1/000001.jpg',b'reference-pixels'*100)
            raw=buffer.getvalue()
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                info=archive.infolist()[0]
                reader=object.__new__(module.RangeArchive)
                reader.read_at=lambda start,count:raw[start:start+count]
                self.assertEqual(reader.member(info),archive.read(info))

    def test_corrupted_reference_frame_cannot_silently_enter_training_data(self):
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_STORED) as archive:
            archive.writestr('frame.jpg',b'reference-pixels')
        raw=bytearray(buffer.getvalue())
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:info=archive.infolist()[0]
        raw[30+len(info.filename)]^=1
        reader=object.__new__(module.RangeArchive)
        reader.read_at=lambda start,count:bytes(raw[start:start+count])
        with self.assertRaisesRegex(RuntimeError,'checksum'):reader.member(info)


if __name__=='__main__':unittest.main()
