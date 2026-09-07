"""Treina e exporta o AVM de apartamentos residenciais de São Paulo.

Fontes oficiais:
- Guias de ITBI pagas de 2026, Prefeitura de São Paulo.
- Anexos I e II da Lei Municipal 18.330/2025 (PGV válida em 2026).

O modelo principal usa área, idade, padrão cadastral do IPTU e o valor
unitário de terreno da PGV. São ajustados 15 modelos independentes para
permitir a exclusão de qualquer combinação dessas quatro variáveis.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import sys
from datetime import date
import itertools
import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import sklearn
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

SCRIPT = Path(__file__).resolve()
ROOT = SCRIPT.parent
DEFAULT_OUTPUT = ROOT / "site" / "assets" / "model.json"
DEFAULT_LOCK = ROOT / "data" / "sources.lock.json"          # nome, URL, publicação e sha256 esperado de cada fonte
DEFAULT_PARITY_INPUTS = ROOT / "tests" / "parity_inputs.json"
DEFAULT_PARITY_FIXTURE = ROOT / "tests" / "parity_fixture.json"
sys.path.insert(0, str(ROOT / "scripts"))
from parity_fixture import write_fixture  # noqa: E402  (mesmo formato do gerador "formula")
ALPHA = 1.0
CONFORMAL_LEVEL = 0.80  # cobertura nominal da faixa; exportada em hyperparameters.interval_nominal_coverage_pct
BASE_YEAR = 2026  # ano-base da idade (idade = BASE_YEAR - ano de conclusão ACC)
# Limites de aplicabilidade: usados nos filtros de clean_data E exportados em payload["applicability"],
# de onde a UI lê para recusar estimativas fora do domínio de treino. Mude aqui, muda nos dois.
LIMITS = {
    "area_m2": (35, 250),
    "year_built": (2006, BASE_YEAR),
    "price_brl": (50_000, 2_250_000),
    "price_m2_brl": (1_500, 35_000),
    "pattern_codes": (20, 25),
    "proportion_pct": (99, 100),
    "date": ("2025-07-01", "2026-07-31"),
}

VARIABLE_ORDER = ["area", "age", "pattern", "fiscal"]
NUMERIC_GROUPS = {
    "area": ["log_area", "log_area2", "log_area3"],
    "age": ["age", "age2"],
    "fiscal": ["log_fiscal", "log_fiscal2"],
}
VARIABLE_LABELS = {
    "area": "Área (curva contínua)",
    "age": "Idade",
    "pattern": "Padrão cadastral IPTU",
    "fiscal": "Valor fiscal PGV (VM2T)",
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_lock(lock_path: Path) -> dict:
    return json.loads(lock_path.read_text(encoding="utf-8"))["sources"]


def verify_source(path: Path, entry: dict) -> None:
    """Falha se a fonte não existir ou se o sha256 divergir do lock. Sem bypass: hash errado = base errada."""
    if not path.exists():
        raise SystemExit(
            f"Fonte ausente: {path}\nBaixe de {entry.get('download_url') or entry.get('page_url')} "
            f"para data/raw/ (fora do git) e confira o sha256 {entry['sha256'][:12]}…"
        )
    actual = file_sha256(path)
    if actual != entry["sha256"]:
        raise SystemExit(
            f"sha256 de {path.name} divergiu do lock {entry['sha256'][:12]}… (obtido {actual[:12]}…). "
            "Se a base mudou de propósito, atualize data/sources.lock.json no mesmo commit."
        )


def read_source(path: Path) -> tuple[pd.DataFrame, list[str]]:
    sheets = pd.read_excel(path, sheet_name=None)
    monthly = []
    names = []
    for name, frame in sheets.items():
        if not name.endswith("-2026"):
            continue
        frame = frame.loc[:, ~frame.columns.astype(str).str.startswith("Unnamed")].copy()
        frame["source_sheet"] = name
        monthly.append(frame)
        names.append(name)
    if not monthly:
        raise ValueError("O arquivo não contém abas mensais terminadas em -2026.")
    return pd.concat(monthly, ignore_index=True), names


def extract_pgv_text(path: Path) -> str:
    if path.suffix.lower() == ".txt":
        return path.read_text(encoding="utf-8", errors="ignore")
    executable = shutil.which("pdftotext")
    if executable:
        result = subprocess.run(
            [executable, "-layout", str(path), "-"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        return result.stdout
    from pypdf import PdfReader

    return "\n".join((page.extract_text() or "") for page in PdfReader(path).pages)


def read_pgv(path: Path) -> tuple[pd.DataFrame, dict]:
    text = extract_pgv_text(path)
    rows = re.findall(r"(?m)^\s*(\d{6})\s+(\d{6})\s+(\d+)\s*$", text)
    if len(rows) < 100_000:
        raise ValueError(f"Extração incompleta do Anexo II da PGV: apenas {len(rows)} linhas.")
    detailed = pd.DataFrame(rows, columns=["codlog", "sq", "fiscal"]).astype({"fiscal": float})
    if detailed.duplicated(["codlog", "sq"]).any():
        raise ValueError("A PGV contém pares Codlog/SQ duplicados; revise a fonte.")
    by_square = detailed.groupby("sq", as_index=False).agg(
        fiscal=("fiscal", "median"),
        pgv_faces=("fiscal", "size"),
        fiscal_min_sq=("fiscal", "min"),
        fiscal_max_sq=("fiscal", "max"),
    )
    metadata = {
        "rows_parsed": int(len(detailed)),
        "tax_squares": int(by_square["sq"].nunique()),
        "codlogs": int(detailed["codlog"].nunique()),
        "value_min": int(detailed["fiscal"].min()),
        "value_max": int(detailed["fiscal"].max()),
    }
    return by_square, metadata


def clean_data(raw: pd.DataFrame, pgv: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    def number(name: str) -> pd.Series:
        return pd.to_numeric(raw[name], errors="coerce")

    nature = raw["Natureza de Transação"].astype(str).str.strip()
    purchase_sale = nature.eq("1.Compra e venda")
    date = pd.to_datetime(raw["Data de Transação"], errors="coerce")
    area = number("Área Construída (m2)")
    price = number("Valor de Transação (declarado pelo contribuinte)")
    year_built = number("ACC (IPTU)")
    use = number("Uso (IPTU)")
    proportion = number("Proporção Transmitida (%)")
    pattern = number("Padrão (IPTU)")

    selected = raw[
        purchase_sale
        & proportion.between(*LIMITS["proportion_pct"])
        & area.between(*LIMITS["area_m2"])
        & year_built.between(*LIMITS["year_built"])
        & price.between(*LIMITS["price_brl"])
        & use.eq(20)
        & pattern.between(*LIMITS["pattern_codes"])
        & raw["Situação do SQL"].astype(str).str.startswith("Ativo Predial")
        & date.between(*LIMITS["date"])
    ].copy()

    selected["area"] = pd.to_numeric(selected["Área Construída (m2)"], errors="coerce")
    selected["price"] = pd.to_numeric(
        selected["Valor de Transação (declarado pelo contribuinte)"], errors="coerce"
    )
    selected["date"] = pd.to_datetime(selected["Data de Transação"], errors="coerce")
    selected["year_built"] = pd.to_numeric(selected["ACC (IPTU)"], errors="coerce")
    selected["age"] = BASE_YEAR - selected["year_built"]  # já em [0, 20] pelo filtro de year_built
    selected["pattern"] = (
        pd.to_numeric(selected["Padrão (IPTU)"], errors="coerce").astype(int).astype(str)  # sem NaN: filtrado acima
    )
    selected["price_m2"] = selected["price"] / selected["area"]
    selected = selected[selected["price_m2"].between(*LIMITS["price_m2_brl"])].copy()

    selected["sql"] = (
        pd.to_numeric(selected["N° do Cadastro (SQL)"], errors="coerce")
        .fillna(0).astype("int64").astype(str).str.zfill(11)
    )
    selected["sq"] = selected["sql"].str[:6]
    selected["cep8"] = (
        pd.to_numeric(selected["CEP"], errors="coerce")
        .fillna(0).astype("int64").astype(str).str.zfill(8)
    )
    selected["cep3"] = selected["cep8"].str[:3]
    selected["cep4"] = selected["cep8"].str[:4]

    before_join = len(selected)
    selected = selected.merge(pgv, on="sq", how="left", validate="many_to_one")
    matched = int(selected["fiscal"].notna().sum())
    selected = selected.dropna(subset=["fiscal"]).copy()

    selected["log_area"] = np.log(selected["area"] / 80.0)
    selected["log_area2"] = selected["log_area"] ** 2
    selected["log_area3"] = selected["log_area"] ** 3
    selected["age2"] = (selected["age"] / 10.0) ** 2
    selected["log_fiscal"] = np.log(selected["fiscal"] / 3_000.0)
    selected["log_fiscal2"] = selected["log_fiscal"] ** 2

    dedupe = ["sql", "date", "price", "area", "Complemento", "Matrícula do Imóvel"]
    selected = selected.drop_duplicates(dedupe).sort_values("date").reset_index(drop=True)
    audit = {
        "raw_rows": int(len(raw)),
        "purchase_sale_rows_raw": int(purchase_sale.sum()),
        "other_natures_ignored_raw": int((~purchase_sale).sum()),
        "eligible_before_pgv_join": int(before_join),
        "pgv_matches": matched,
        "pgv_join_coverage_pct": round(100 * matched / before_join, 2) if before_join else 0,
    }
    return selected, audit


def split_temporal(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    train_end = int(len(df) * 0.70)
    calibration_end = int(len(df) * 0.85)
    return (
        df.iloc[:train_end].copy(),
        df.iloc[train_end:calibration_end].copy(),
        df.iloc[calibration_end:].copy(),
    )


def regression_metrics(y_true_log: np.ndarray, y_pred_log: np.ndarray) -> dict:
    actual = np.exp(y_true_log)
    predicted = np.exp(y_pred_log)
    ape = np.abs((actual - predicted) / actual)
    return {
        "r2_log": round(float(r2_score(y_true_log, y_pred_log)), 4),
        "mae_brl": round(float(mean_absolute_error(actual, predicted)), 2),
        "rmse_brl": round(float(mean_squared_error(actual, predicted) ** 0.5), 2),
        "mape_pct": round(float(ape.mean() * 100), 2),
        "med_ape_pct": round(float(np.median(ape) * 100), 2),
    }


def fit_subset(
    subset: tuple[str, ...],
    train: pd.DataFrame,
    calibration: pd.DataFrame,
    test: pd.DataFrame,
) -> dict:
    numeric_features = [
        feature for variable in subset for feature in NUMERIC_GROUPS.get(variable, [])
    ]
    categorical_features = ["pattern"] if "pattern" in subset else []
    transformers = []
    if numeric_features:
        transformers.append(("num", StandardScaler(), numeric_features))
    if categorical_features:
        transformers.append((
            "cat",
            OneHotEncoder(handle_unknown="ignore", sparse_output=True),
            categorical_features,
        ))

    prep = ColumnTransformer(transformers)
    pipeline = Pipeline([("prep", prep), ("model", Ridge(alpha=ALPHA))])
    input_features = numeric_features + categorical_features
    pipeline.fit(train[input_features], np.log(train["price"]))

    cal_prediction = pipeline.predict(calibration[input_features])
    cal_actual = np.log(calibration["price"].to_numpy())
    q80 = float(np.quantile(np.abs(cal_actual - cal_prediction), CONFORMAL_LEVEL, method="higher"))

    test_prediction = pipeline.predict(test[input_features])
    test_actual = np.log(test["price"].to_numpy())
    metrics = regression_metrics(test_actual, test_prediction)
    coverage = np.mean(
        (test_actual >= test_prediction - q80) & (test_actual <= test_prediction + q80)
    )
    metrics["interval_80_coverage_pct"] = round(float(coverage * 100), 2)
    metrics["test_rows"] = int(len(test))

    coefficients = np.asarray(pipeline.named_steps["model"].coef_).ravel()
    numeric_payload = {"features": [], "means": [], "scales": [], "coefficients": []}
    effect_norms: dict[str, float] = {}
    offset = 0
    if numeric_features:
        scaler = prep.named_transformers_["num"]
        count = len(numeric_features)
        numeric_coefs = coefficients[:count]
        numeric_payload = {
            "features": numeric_features,
            "means": [round(float(x), 12) for x in scaler.mean_],
            "scales": [round(float(x), 12) for x in scaler.scale_],
            "coefficients": [round(float(x), 12) for x in numeric_coefs],
        }
        for variable in subset:
            features = NUMERIC_GROUPS.get(variable, [])
            if features:
                indices = [numeric_features.index(feature) for feature in features]
                effect_norms[variable] = float(np.linalg.norm(numeric_coefs[indices]))
        offset = count

    category_coefficients: dict[str, dict[str, float]] = {}
    if categorical_features:
        encoder = prep.named_transformers_["cat"]
        for feature, categories in zip(categorical_features, encoder.categories_):
            size = len(categories)
            values = coefficients[offset:offset + size]
            category_coefficients[feature] = {
                str(category): round(float(value), 12)
                for category, value in zip(categories, values)
            }
            effect_norms[feature] = float(np.linalg.norm(values))
            offset += size

    return {
        "pipeline": pipeline,  # removido do payload em main(); usado só na fixture de paridade
        "variables": list(subset),
        "intercept": round(float(pipeline.named_steps["model"].intercept_), 12),
        "numeric": numeric_payload,
        "category_coefficients": category_coefficients,
        "conformal_q80_log": round(q80, 12),
        "metrics": metrics,
        "effect_norms": {key: round(value, 12) for key, value in effect_norms.items()},
    }


def stats_by(frame: pd.DataFrame, key: str) -> dict:
    valid = frame[frame[key].astype(str).str.match(r"^\d+$")].copy()
    grouped = valid.groupby(key).agg(
        n=("price", "size"),
        median_price_m2=("price_m2", "median"),
        median_price=("price", "median"),
        median_fiscal=("fiscal", "median"),
    )
    return {
        str(index): {
            "n": int(row.n),
            "median_price_m2": round(float(row.median_price_m2)),
            "median_price": round(float(row.median_price)),
            "median_fiscal": round(float(row.median_fiscal)),
        }
        for index, row in grouped.iterrows()
    }


def parity_features(case: dict) -> dict:
    """Mesmas transformações de clean_data para um imóvel de referência (age já é a idade, 0–20)."""
    log_area = float(np.log(case["area"] / 80.0))
    log_fiscal = float(np.log(case["fiscal"] / 3_000.0))
    return {
        "log_area": log_area, "log_area2": log_area ** 2, "log_area3": log_area ** 3,
        "age": float(case["age"]), "age2": (float(case["age"]) / 10.0) ** 2,
        "log_fiscal": log_fiscal, "log_fiscal2": log_fiscal ** 2,
        "pattern": str(case["pattern"]),
    }


def main(
    source: Path,
    pgv_path: Path,
    output: Path,
    trained_at: str,
    lock_path: Path,
    parity_inputs: Path,
    parity_fixture: Path,
) -> None:
    lock = load_lock(lock_path)
    verify_source(source, lock["itbi"])
    verify_source(pgv_path, lock["pgv"])

    raw, sheet_names = read_source(source)
    pgv, pgv_meta = read_pgv(pgv_path)
    df, audit = clean_data(raw, pgv)
    train, calibration, test = split_temporal(df)

    models = {}
    for size in range(1, len(VARIABLE_ORDER) + 1):
        for subset in itertools.combinations(VARIABLE_ORDER, size):
            key = "+".join(subset)
            models[key] = fit_subset(subset, train, calibration, test)
    pipelines = {key: model.pop("pipeline") for key, model in models.items()}

    default_key = "+".join(VARIABLE_ORDER)
    default_model = models[default_key]
    effect_total = sum(default_model["effect_norms"].values()) or 1.0

    area_bins = [35, 50, 65, 80, 100, 130, 170, 210, 251]
    area_counts, _ = np.histogram(df["area"], bins=area_bins)
    pm2_bins = [1_500, 3_000, 4_000, 5_000, 6_000, 8_000, 10_000, 14_000, 35_001]
    pm2_labels = [
        "1,5–2,9 mil", "3–3,9 mil", "4–4,9 mil", "5–5,9 mil",
        "6–7,9 mil", "8–9,9 mil", "10–13,9 mil", "14–35 mil",
    ]
    pm2_counts, _ = np.histogram(df["price_m2"], bins=pm2_bins)
    fiscal_bins = [0, 1_000, 2_000, 3_000, 5_000, 8_000, 12_000, 20_000, 50_000]
    fiscal_labels = [
        "até 999", "1–1,9 mil", "2–2,9 mil", "3–4,9 mil",
        "5–7,9 mil", "8–11,9 mil", "12–19,9 mil", "20–50 mil",
    ]
    fiscal_counts, _ = np.histogram(df["fiscal"], bins=fiscal_bins)

    patterns = [
        {"code": int(code), "label": f"2-{chr(65 + int(code) - 20)}", "n": int(count)}
        for code, count in df["pattern"].value_counts().sort_index().items()
    ]
    payload = {
        "version": "SP-AVM-ITBI-PGV-2026.07-R2",
        "trained_at": trained_at,
        "reference_date": "2026-07-01",
        "default_model_key": default_key,
        "variable_order": VARIABLE_ORDER,
        "variable_definitions": {
            "area": {
                "label": "Área construída cadastral",
                "unit": "m²",
                "transformation": "polinômio cúbico de ln(área/80)",
            },
            "age": {
                "label": "Idade",
                "unit": "anos",
                "transformation": "idade e idade²",
            },
            "pattern": {
                "label": "Padrão cadastral IPTU",
                "unit": "categoria",
                "transformation": "one-hot dos padrões do tipo 2",
            },
            "fiscal": {
                "label": "Valor fiscal PGV",
                "unit": "R$/m² de terreno",
                "transformation": "ln(VM2T/3.000) e seu quadrado",
            },
        },
        "applicability": {
            "$comment": "Domínio de treino. A UI recusa estimativas fora destes limites.",
            "area_m2": list(LIMITS["area_m2"]),
            "year_built": list(LIMITS["year_built"]),
            "base_year": BASE_YEAR,
            "age_years": [0, BASE_YEAR - LIMITS["year_built"][0]],
            "price_brl": list(LIMITS["price_brl"]),
            "price_m2_brl": list(LIMITS["price_m2_brl"]),
            "fiscal_vm2t_brl": [int(df["fiscal"].min()), int(df["fiscal"].max())],
            "pattern_codes": sorted(int(code) for code in df["pattern"].unique()),
            "use_iptu": 20,
            "nature": "1.Compra e venda",
            "sql_status": "Ativo Predial",
            "transaction_dates": list(LIMITS["date"]),
        },
        "models": models,
        "patterns": patterns,
        "hyperparameters": {
            "algorithm": "Ridge hedônico com modelos por subconjunto",
            "alpha": ALPHA,
            "target": "ln(valor de transação declarado)",
            "candidate_variables": "área, idade, padrão cadastral IPTU e valor fiscal PGV",
            "models_fitted": len(models),
            "validation": "divisão temporal 70% treino, 15% calibração e 15% teste",
            "interval": f"split conformal independente por subconjunto, cobertura nominal de {round(CONFORMAL_LEVEL * 100)}%",
            "interval_nominal_coverage_pct": round(CONFORMAL_LEVEL * 100),
            "continuous_area": True,
            "nature_filter": "somente Natureza de Transação igual a 1.Compra e venda",
            "condominium_fee": "excluída da base, do treinamento e da inferência",
            "financing_system": "metadado de enquadramento; não integra a precificação",
        },
        "libraries": {
            "python": f"{sys.version_info.major}.{sys.version_info.minor}",
            "pandas": pd.__version__,
            "numpy": np.__version__,
            "scikit_learn": sklearn.__version__,
            "pypdf": library_version("pypdf"),  # usado só sem pdftotext
        },
        "source": {
            "name": "Guias de ITBI pagas — Município de São Paulo",
            "publisher": "Secretaria Municipal da Fazenda de São Paulo",
            "page_url": lock["itbi"]["page_url"],
            "download_url": lock["itbi"]["download_url"],
            "file": source.name,
            "sha256": lock["itbi"]["sha256"],  # já conferido em verify_source
            "sheets": sheet_names,
            "transaction_date_min": df["date"].min().date().isoformat(),
            "transaction_date_max": df["date"].max().date().isoformat(),
            "download_page_updated": lock["itbi"]["published"],
        },
        "pgv_source": {
            "name": "Anexos I e II da Lei Municipal 18.330/2025 — PGV 2026",
            "publisher": "Prefeitura do Município de São Paulo",
            "law_url": lock["pgv"]["page_url"],
            "file": pgv_path.name,
            "sha256": lock["pgv"]["sha256"],
            "field": "VM2T do Anexo II — valor unitário de metro quadrado de terreno",
            "training_join": "SQL → setor e quadra (SQ); mediana dos valores das faces de quadra",
            "subject_input": "informar o VM2T exato do trecho de logradouro e SQ do imóvel",
            **pgv_meta,
            **audit,
        },
        "metrics": default_model["metrics"],
        "eda": {
            "rows_raw": int(len(raw)),
            "rows_model": int(len(df)),
            "rows_train": int(len(train)),
            "rows_calibration": int(len(calibration)),
            "rows_test": int(len(test)),
            "cep3_regions": int(df["cep3"].nunique()),
            "area_median": round(float(df["area"].median()), 1),
            "area_q1": round(float(df["area"].quantile(.25)), 1),
            "area_q3": round(float(df["area"].quantile(.75)), 1),
            "price_median": round(float(df["price"].median())),
            "price_q1": round(float(df["price"].quantile(.25))),
            "price_q3": round(float(df["price"].quantile(.75))),
            "price_m2_median": round(float(df["price_m2"].median())),
            "fiscal_min": round(float(df["fiscal"].min())),
            "fiscal_q1": round(float(df["fiscal"].quantile(.25))),
            "fiscal_median": round(float(df["fiscal"].median())),
            "fiscal_q3": round(float(df["fiscal"].quantile(.75))),
            "fiscal_max": round(float(df["fiscal"].max())),
            "area_hist": [
                {"label": f"{area_bins[i]}–{area_bins[i + 1] - 1}", "count": int(area_counts[i])}
                for i in range(len(area_counts))
            ],
            "price_m2_hist": [
                {"label": pm2_labels[i], "count": int(pm2_counts[i])}
                for i in range(len(pm2_counts))
            ],
            "fiscal_hist": [
                {"label": fiscal_labels[i], "count": int(fiscal_counts[i])}
                for i in range(len(fiscal_counts))
            ],
        },
        "cep3_stats": stats_by(df, "cep3"),
        "cep4_stats": stats_by(df, "cep4"),
        "feature_effects": [
            {
                "feature": VARIABLE_LABELS[key],
                "importance": round(value / effect_total, 6),
            }
            for key, value in sorted(
                default_model["effect_norms"].items(),
                key=lambda item: item[1],
                reverse=True,
            )
        ],
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    def sklearn_log_price(key: str, case: dict) -> float:
        row = pd.DataFrame([parity_features(case)])
        features = models[key]["numeric"]["features"] + (["pattern"] if "pattern" in models[key]["variables"] else [])
        return float(pipelines[key].predict(row[features])[0])

    fixture_path = write_fixture(output, parity_inputs, parity_fixture, sklearn_log_price, reference="sklearn")
    print(json.dumps({
        "output": str(output),
        "parity_fixture": str(fixture_path),
        "default_model": default_key,
        "metrics": payload["metrics"],
        "model_count": len(models),
        "eda": payload["eda"],
        "nature_audit": {
            key: payload["pgv_source"][key]
            for key in [
                "raw_rows", "purchase_sale_rows_raw", "other_natures_ignored_raw",
                "eligible_before_pgv_join", "pgv_matches", "pgv_join_coverage_pct",
            ]
        },
    }, ensure_ascii=False, indent=2))


def library_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK, help="data/sources.lock.json")
    parser.add_argument("--source", type=Path, help="xlsx do ITBI (default: file do lock)")
    parser.add_argument("--pgv", type=Path, help="PDF (ou .txt) dos anexos da PGV (default: file do lock)")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--trained-at", default=date.today().isoformat(), help="AAAA-MM-DD (default: hoje)")
    parser.add_argument("--parity-inputs", type=Path, default=DEFAULT_PARITY_INPUTS)
    parser.add_argument("--parity-fixture", type=Path, default=DEFAULT_PARITY_FIXTURE)
    args = parser.parse_args()
    sources = load_lock(args.lock)
    main(
        args.source or ROOT / sources["itbi"]["file"],
        args.pgv or ROOT / sources["pgv"]["file"],
        args.output,
        args.trained_at,
        args.lock,
        args.parity_inputs,
        args.parity_fixture,
    )
