import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-processor"))
from tracking_cache import ObservationStore, atomic_json, scene_key


class CacheTests(unittest.TestCase):
    def test_observations_survive_restart_and_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"observations.sqlite"
            store=ObservationStore(path,{"model":"a"})
            store.put(42,[[{"cx":.2}],[]])
            result=store.get(42)
            result[0][0]["trackId"]=7
            self.assertNotIn("trackId",store.get(42)[0][0])
            store.close()
            reopened=ObservationStore(path,{"model":"a"})
            self.assertIsNotNone(reopened.get(42))
            reopened.close()
            changed=ObservationStore(path,{"model":"b"})
            self.assertIsNone(changed.get(42))
            changed.close()

    def test_parallel_scene_workers_share_a_fresh_observation_database(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "observations.sqlite"

            def write_observation(frame):
                store = ObservationStore(path, {"model": "parallel"})
                store.put(frame, {"frame": frame})
                self.assertEqual(store.get(frame), {"frame": frame})
                store.close()

            with ThreadPoolExecutor(max_workers=8) as workers:
                list(workers.map(write_observation, range(24)))

            store = ObservationStore(path, {"model": "parallel"})
            for frame in range(24):
                self.assertEqual(store.get(frame), {"frame": frame})
            store.close()

    def test_scene_cache_ignores_text_but_not_timing(self):
        moment={"startTime":1,"endTime":8,"eventType":"goal","trackingBrief":{"contactTime":4}}
        key=scene_key(moment,{"model":"a"})
        self.assertEqual(key,scene_key(dict(moment,commentary="new voice",colorGrade="gold"),{"model":"a"}))
        self.assertNotEqual(key,scene_key(dict(moment,endTime=9),{"model":"a"}))
        self.assertNotEqual(key,scene_key(moment,{"model":"b"}))

    def test_atomic_scene_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"scene.json"
            atomic_json(path,{"complete":True})
            self.assertIn("true",path.read_text())
            self.assertEqual(len(list(Path(directory).iterdir())),1)


if __name__ == "__main__":
    unittest.main()
