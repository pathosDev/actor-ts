# Test-only TLS material

A throwaway CA and a leaf certificate for `localhost` / `127.0.0.1`, used by
`tests/unit/http/HttpServerTls.test.ts` and `tests/smoke/cases/36-http-tls-termination.mjs`
to prove that the HTTP backends terminate TLS (#1522).  Every client in those
tests verifies against `test-ca.pem`; none sets `rejectUnauthorized: false`.

**The private key is committed on purpose and protects nothing.**  It signs a
certificate for `localhost` issued by a CA that exists only in this directory.
It must never be used outside a test.

Two-tier rather than a single self-signed certificate because Deno's TLS stack
(rustls) will not accept a leaf as its own trust anchor — a self-signed
`localhost` certificate with `CA:TRUE` was still refused as an "invalid peer
certificate" — while a CA-signed leaf verified by the CA passes on all three
runtimes.

Valid for ten years from 2026-09-11.  To regenerate (OpenSSL 3; on Git Bash,
`MSYS_NO_PATHCONV=1` keeps the `/CN=` subject from being read as a path):

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout ca-key.pem -out test-ca.pem -days 3650 -subj "/CN=actor-ts test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout localhost-key.pem -out leaf.csr -subj "/CN=localhost"
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n" > leaf.ext
openssl x509 -req -in leaf.csr -CA test-ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out localhost-cert.pem -days 3650 -extfile leaf.ext
rm ca-key.pem leaf.csr leaf.ext test-ca.srl
```

The CA key is deleted after signing: nothing needs to sign a second leaf, and
a regenerated set replaces all three files together.
