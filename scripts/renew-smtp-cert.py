"""
Renews the Let's Encrypt cert for smtp.continuumapi.com and pushes it to the
smtp-relay Railway service, bypassing certbot (which refuses to run without
admin rights on Windows) by driving the ACME v2 DNS-01 flow directly.

Requires: pip install acme josepy cryptography requests
Requires: Railway CLI logged in with access to the continuum-deploy project,
          and the current working directory set to that repo (so `railway`
          resolves the linked project/environment).

Usage: python scripts/renew-smtp-cert.py
"""
import json
import os
import subprocess
import sys
import time

import requests
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

import josepy as jose
from acme import client, messages, challenges, errors as acme_errors

DOMAIN = "smtp.continuumapi.com"
EMAIL = "sumeet@continuumapi.com"
DIRECTORY_URL = "https://acme-v02.api.letsencrypt.org/directory"
RAILWAY_SERVICE = "smtp-relay"
RAILWAY_ENV = "production"

CF_TOKEN = os.environ.get("CF_API_TOKEN")
CF_ZONE_ID = os.environ.get("CF_ZONE_ID")
if not CF_TOKEN or not CF_ZONE_ID:
    print("Set CF_API_TOKEN and CF_ZONE_ID env vars before running.", file=sys.stderr)
    sys.exit(1)

CF_API = "https://api.cloudflare.com/client/v4"
cf_headers = {"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"}


def cf_create_txt(name, value):
    r = requests.post(
        f"{CF_API}/zones/{CF_ZONE_ID}/dns_records",
        headers=cf_headers,
        json={"type": "TXT", "name": name, "content": value, "ttl": 60},
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        raise RuntimeError(f"Cloudflare TXT create failed: {data}")
    return data["result"]["id"]


def cf_delete_record(record_id):
    r = requests.delete(f"{CF_API}/zones/{CF_ZONE_ID}/dns_records/{record_id}", headers=cf_headers)
    r.raise_for_status()


def cf_txt_live(name, value, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(
                "https://cloudflare-dns.com/dns-query",
                headers={"accept": "application/dns-json"},
                params={"name": name, "type": "TXT"},
                timeout=10,
            )
            for a in r.json().get("Answer", []):
                if value in a.get("data", ""):
                    return True
        except Exception as e:
            print(f"  (propagation check error, retrying: {e})")
        time.sleep(5)
    return False


def set_railway_var(key, value):
    proc = subprocess.run(
        ["railway", "variable", "set", key, "--stdin", "--skip-deploys",
         "--service", RAILWAY_SERVICE, "-e", RAILWAY_ENV],
        input=value.encode(), capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"railway variable set {key} failed: {proc.stderr.decode()}")


def main():
    print("[1/7] Generating ACME account key + registering...")
    acc_key = jose.JWKRSA(key=rsa.generate_private_key(public_exponent=65537, key_size=2048))
    net = client.ClientNetwork(acc_key, user_agent="continuum-acme-renew/1.0")
    directory = messages.Directory.from_json(net.get(DIRECTORY_URL).json())
    acme_client = client.ClientV2(directory, net=net)
    acme_client.new_account(messages.NewRegistration.from_data(email=EMAIL, terms_of_service_agreed=True))

    print("[2/7] Generating certificate key + CSR...")
    cert_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert_key_pem = cert_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, DOMAIN)]))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(DOMAIN)]), critical=False)
        .sign(cert_key, hashes.SHA256())
    )
    csr_pem = csr.public_bytes(serialization.Encoding.PEM)

    print("[3/7] Creating ACME order...")
    order = acme_client.new_order(csr_pem)

    record_id = None
    try:
        print("[4/7] Answering DNS-01 challenge via Cloudflare...")
        authz = order.authorizations[0]
        dns_challenge = next(c for c in authz.body.challenges if isinstance(c.chall, challenges.DNS01))
        response, validation = dns_challenge.response_and_validation(acme_client.net.key)
        record_name = f"_acme-challenge.{DOMAIN}"
        record_id = cf_create_txt(record_name, validation)

        print("[5/7] Waiting for DNS propagation...")
        if not cf_txt_live(record_name, validation):
            time.sleep(20)
        else:
            time.sleep(10)

        print("[6/7] Finalizing order...")
        acme_client.answer_challenge(dns_challenge, response)
        finalized = acme_client.poll_and_finalize(order, deadline=None)
        fullchain_pem = finalized.fullchain_pem
        if isinstance(fullchain_pem, bytes):
            fullchain_pem = fullchain_pem.decode()

        print("[7/7] Pushing new cert/key to Railway and redeploying...")
        cert_escaped = fullchain_pem.replace("\r\n", "\n").replace("\n", "\\n")
        key_escaped = cert_key_pem.replace("\r\n", "\n").replace("\n", "\\n")
        set_railway_var("SMTP_RELAY_TLS_CERT", cert_escaped)
        set_railway_var("SMTP_RELAY_TLS_KEY", key_escaped)

        deploy = subprocess.run(
            ["railway", "up", "--service", RAILWAY_SERVICE, "-e", RAILWAY_ENV, "--detach"],
            capture_output=True,
        )
        if deploy.returncode != 0:
            raise RuntimeError(f"railway up failed: {deploy.stderr.decode()}")

        print("Done. New cert deployed to smtp-relay.")
    finally:
        if record_id:
            try:
                cf_delete_record(record_id)
            except Exception as e:
                print(f"  (TXT cleanup failed, non-fatal: {e})")


if __name__ == "__main__":
    try:
        main()
    except acme_errors.ValidationError as e:
        print("ACME VALIDATION ERROR:")
        for authzr in e.failed_authzrs:
            print(json.dumps(authzr.to_partial_json(), indent=2))
        sys.exit(1)
