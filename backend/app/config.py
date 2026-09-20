from pathlib import Path
import os

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = Path(os.getenv('PREVENTX_ARTIFACTS_DIR', ROOT/'artifacts'))
MITRE_DIR = ROOT/'data'/'mitre'
STATE_SECONDS=10
HISTORY_STATES=5 
N_FEATURES=45
HORIZONS=[10,20,30,40,50,60]
THRESHOLD=0.05
MODEL_PATH=ARTIFACTS/'prevent_x_transformer_best.pt'
SCALER_PATH=ARTIFACTS/'prevent_x_training_scaler.joblib'
ARCH_PATH=ARTIFACTS/'prevent_x_transformer_architecture.json'
THRESHOLD_PATH=ARTIFACTS/'prevent_x_operational_threshold.json'
