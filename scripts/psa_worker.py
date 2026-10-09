"""Compatibility entry point for the certificate worker v2."""
# Keep existing psa_worker.bat compatible without reading or exposing its key.
from cert_worker_runtime import main

if __name__ == "__main__":
    raise SystemExit(main())
