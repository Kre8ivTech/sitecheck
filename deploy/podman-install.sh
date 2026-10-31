#!/usr/bin/env bash
set -euo pipefail
# Run from an exact, tested release directory as the hosting operator.
release_dir="$(pwd)"
release_revision="${1:?Pass the tested Git revision}"
image="localhost/sitecheck:${release_revision}"
podman build --memory=2g --cpu-period=100000 --cpu-quota=200000 -t "$image" .
podman network exists sitecheck-isolated || podman network create --internal sitecheck-isolated
podman network exists sitecheck-outbound || podman network create sitecheck-outbound
install -d -m 700 /opt/sitecheck/data
podman run --rm --user 0 --network none -v /opt/sitecheck/data:/data:Z "$image" chown pwuser:pwuser /data
for unit in container-sitecheck-edge.service container-sitecheck-web.service container-sitecheck-egress.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then systemctl stop "$unit"; fi
done
for name in sitecheck-edge sitecheck-web sitecheck-egress; do
  if podman container exists "$name"; then podman stop --time 10 "$name"; podman rm "$name"; fi
done
podman run -d --name sitecheck-egress --init \
  --network sitecheck-isolated --network sitecheck-outbound --network-alias egress \
  --read-only --memory 192m --cpus 0.5 --pids-limit 32 --cap-drop ALL \
  --security-opt no-new-privileges --log-opt max-size=10mb \
  "$image" node dist/egress-main.js
podman run -d --name sitecheck-web --init --network sitecheck-isolated --network-alias web \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m --shm-size 256m \
  --memory 2g --cpus 1.5 --pids-limit 256 --cap-drop ALL \
  --security-opt no-new-privileges --security-opt "seccomp=${release_dir}/deploy/chromium-seccomp.json" \
  --log-opt max-size=10mb -v /opt/sitecheck/data:/data:Z \
  -e HOST=0.0.0.0 -e PORT=3100 -e PUBLIC_ORIGIN=https://sitecheck.kre8ivtech.com \
  -e SITECHECK_PROXY=http://egress:3128 -e SITECHECK_DATA=/data -e TRUST_PROXY_HOPS=2 \
  "$image"
podman run -d --name sitecheck-edge --network sitecheck-isolated --network sitecheck-outbound \
  -p 127.0.0.1:3100:8080 --read-only --tmpfs /tmp:rw,size=32m \
  --memory 64m --cpus 0.25 --pids-limit 32 --cap-drop ALL --security-opt no-new-privileges \
  --log-opt max-size=10mb -v "${release_dir}/deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro,Z" \
  docker.io/nginxinc/nginx-unprivileged@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
for name in sitecheck-egress sitecheck-web sitecheck-edge; do
  podman generate systemd --name "$name" --restart-policy=always > "/etc/systemd/system/container-${name}.service"
done
install -d /etc/systemd/system/container-sitecheck-web.service.d /etc/systemd/system/container-sitecheck-edge.service.d
printf '[Unit]\nAfter=container-sitecheck-egress.service\nRequires=container-sitecheck-egress.service\n' > /etc/systemd/system/container-sitecheck-web.service.d/dependencies.conf
printf '[Unit]\nAfter=container-sitecheck-web.service\nRequires=container-sitecheck-web.service\n' > /etc/systemd/system/container-sitecheck-edge.service.d/dependencies.conf
systemctl daemon-reload
podman stop --time 10 sitecheck-edge sitecheck-web sitecheck-egress
systemctl enable --now container-sitecheck-egress.service container-sitecheck-web.service container-sitecheck-edge.service
curl --retry 10 --retry-connrefused --retry-delay 1 --fail http://127.0.0.1:3100/health
