FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# SQLite database lives here — mount a volume on this path to persist data
# across container recreation/updates. The app defaults to /data/linkledger.db
# (override with LINKLEDGER_DB) and auto-migrates a database from the old
# /data/patchbook.db default path on first boot if one is found there, so
# upgrading an existing Patchbook deployment needs no manual DB steps.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
