#!/usr/bin/env python3
"""Gera tests/parity_fixture.json: ln(preço) esperado para cada caso de tests/parity_inputs.json em cada
um dos 15 modelos. Só stdlib.

Referência "formula": aplica a equação hedônica lida do model.json (este script). Serve só para depurar
a equação localmente: o teste JS (tests/parity.test.mjs) EXIGE reference "sklearn" e o sha256 do model.json
igual ao da fixture, para que um model.json editado à mão não passe no CI (VULN-004).
Referência "sklearn": train_model.py chama write_fixture() com os pipelines recém-treinados, a verdade de fato.

Uso: python3 scripts/parity_fixture.py [model.json] [parity_inputs.json] [parity_fixture.json]
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
TOLERANCE_LOG = 1e-9


def features(case: dict) -> dict:
    log_area = math.log(case["area"] / 80.0)
    log_fiscal = math.log(case["fiscal"] / 3000.0)
    age = float(case["age"])
    return {
        "log_area": log_area, "log_area2": log_area ** 2, "log_area3": log_area ** 3,
        "age": age, "age2": (age / 10.0) ** 2,
        "log_fiscal": log_fiscal, "log_fiscal2": log_fiscal ** 2,
    }


def formula_log_price(model: dict, key: str, case: dict) -> float:
    """Espelho da equação em site/assets/predict.js. Mudou aqui, mudou lá."""
    m = model["models"][key]
    f = features(case)
    y = m["intercept"]
    num = m["numeric"]
    for name, mean, scale, coef in zip(num["features"], num["means"], num["scales"], num["coefficients"]):
        y += coef * (f[name] - mean) / scale
    pattern_coefs = m["category_coefficients"].get("pattern")
    if pattern_coefs:  # categoria não vista no treino contribui 0 (OneHotEncoder handle_unknown="ignore")
        y += pattern_coefs.get(str(case["pattern"]), 0.0)
    return y


def write_fixture(
    model_path: Path,
    inputs_path: Path,
    out_path: Path,
    log_price: Callable[[str, dict], float],
    reference: str,
) -> Path:
    model_bytes = model_path.read_bytes()
    model = json.loads(model_bytes)
    cases = json.loads(inputs_path.read_text(encoding="utf-8"))["cases"]
    fixture = {
        "$comment": "Gerado por scripts/parity_fixture.py (formula) ou train_model.py (sklearn). Não edite à mão.",
        "reference": reference,
        "model_version": model["version"],
        "model_trained_at": model["trained_at"],
        "model_sha256": hashlib.sha256(model_bytes).hexdigest(),
        "tolerance_log": TOLERANCE_LOG,
        "cases": [
            {"input": case, "expected_log_price": {key: log_price(key, case) for key in model["models"]}}
            for case in cases
        ],
    }
    out_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return out_path


def main(argv: list[str]) -> int:
    model_path = Path(argv[1]) if len(argv) > 1 else ROOT / "site/assets/model.json"
    inputs_path = Path(argv[2]) if len(argv) > 2 else ROOT / "tests/parity_inputs.json"
    out_path = Path(argv[3]) if len(argv) > 3 else ROOT / "tests/parity_fixture.json"
    model = json.loads(model_path.read_text(encoding="utf-8"))
    out = write_fixture(model_path, inputs_path, out_path, lambda key, case: formula_log_price(model, key, case), "formula")
    n_cases = len(json.loads(inputs_path.read_text(encoding="utf-8"))["cases"])
    print(f"fixture 'formula' gravada em {out}: {n_cases} casos × {len(model['models'])} modelos")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
