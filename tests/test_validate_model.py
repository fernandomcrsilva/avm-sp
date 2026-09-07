"""Checagem mínima do validador: aceita o model.json real e rejeita mutações óbvias.

Uso: python3 -m unittest tests.test_validate_model
"""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from validate_model import validate  # noqa: E402

MODEL = json.loads((Path(__file__).resolve().parents[1] / "site/assets/model.json").read_text(encoding="utf-8"))


class ValidateModelTest(unittest.TestCase):
    def test_real_model_is_valid(self):
        self.assertEqual(validate(MODEL), [])

    def test_missing_model_fails(self):
        m = copy.deepcopy(MODEL)
        del m["models"]["area+age"]
        self.assertTrue(any("15 combinações" in p for p in validate(m)))

    def test_negative_conformal_fails(self):
        m = copy.deepcopy(MODEL)
        m["models"]["area"]["conformal_q80_log"] = -0.1
        self.assertTrue(any("conformal_q80_log" in p for p in validate(m)))

    def test_insane_coverage_fails(self):
        m = copy.deepcopy(MODEL)
        m["models"][m["default_model_key"]]["metrics"]["interval_80_coverage_pct"] = 55.0
        m["metrics"] = m["models"][m["default_model_key"]]["metrics"]
        self.assertTrue(any("interval_80_coverage_pct" in p for p in validate(m)))

    def test_weak_default_model_fails(self):
        m = copy.deepcopy(MODEL)
        m["models"][m["default_model_key"]]["metrics"]["r2_log"] = 0.2
        m["metrics"] = m["models"][m["default_model_key"]]["metrics"]
        self.assertTrue(any("r2_log < 0.5" in p for p in validate(m)))

    def test_applicability_range_fails(self):
        m = copy.deepcopy(MODEL)
        m["applicability"]["area_m2"] = [250, 35]
        self.assertTrue(any("applicability.area_m2" in p for p in validate(m)))

    def test_bad_sha_fails(self):
        m = copy.deepcopy(MODEL)
        m["source"]["sha256"] = "abc"
        self.assertTrue(any("source.sha256" in p for p in validate(m)))


if __name__ == "__main__":
    unittest.main()
