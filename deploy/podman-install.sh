#!/usr/bin/env bash
set -euo pipefail
# Run from an exact, tested release directory as the hosting operator.
release_dir="$(pwd)"
release_revision="${1:?Pass the tested Git revision}"
image="localhost/sitecheck:${release_revision}"
bind_port="${SITECHECK_BIND_PORT:-33117}"
podman build --memory=2g --cpu-period=100000 --cpu-quota=200000 -t "$image" .
podman network exists sitecheck-isolated || podman network create --internal sitecheck-isolated
podman network exists sitecheck-outbound || podman network create sitecheck-outbound
isolated_subnet="$(podman network inspect sitecheck-isolated --format '{{(index .Subnets 0).Subnet}}')"
network_prefix="${isolated_subnet%0/24}"
if [[ "$network_prefix" == "$isolated_subnet" ]]; then echo 'SiteCheck requires a dedicated IPv4 /24 internal network.' >&2; exit 1; fi
egress_ip="${network_prefix}10"
web_ip="${network_prefix}11"
edge_ip="${network_prefix}12"
outbound_subnet="$(podman network inspect sitecheck-outbound --format '{{(index .Subnets 0).Subnet}}')"
outbound_prefix="${outbound_subnet%0/24}"
if [[ "$outbound_prefix" == "$outbound_subnet" ]]; then echo 'SiteCheck requires a dedicated IPv4 /24 outbound network.' >&2; exit 1; fi
edge_outbound_ip="${outbound_prefix}12"
install -d -m 700 /opt/sitecheck/data
podman run --rm --user 0 --network none -v /opt/sitecheck/data:/data:Z "$image" chown pwuser:pwuser /data
for unit in container-sitecheck-edge.service container-sitecheck-web.service container-sitecheck-egress.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then systemctl stop "$unit"; fi
done
for name in sitecheck-edge sitecheck-web sitecheck-egress; do
  if podman container exists "$name"; then podman stop --time 10 "$name"; podman rm "$name"; fi
done
podman run -d --name sitecheck-egress --init \
  --network "sitecheck-isolated:ip=${egress_ip}" --network sitecheck-outbound \
  --read-only --memory 192m --cpus 0.5 --pids-limit 32 --cap-drop ALL \
  --security-opt no-new-privileges --log-opt max-size=10mb \
  "$image" node dist/egress-main.js
podman run -d --name sitecheck-web --init --network "sitecheck-isolated:ip=${web_ip}" \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m --shm-size 256m \
  --memory 2g --cpus 1.5 --pids-limit 256 --cap-drop ALL \
  --security-opt no-new-privileges --security-opt "seccomp=${release_dir}/deploy/chromium-seccomp.json" \
  --log-opt max-size=10mb -v /opt/sitecheck/data:/data:Z \
  -e HOST=0.0.0.0 -e PORT=3100 -e PUBLIC_ORIGIN=https://sitecheck.kre8ivtech.com \
  -e "SITECHECK_PROXY=http://${egress_ip}:3128" -e SITECHECK_DATA=/data -e TRUST_PROXY_HOPS=2 \
  "$image"
podman run -d --name sitecheck-edge --network "sitecheck-outbound:ip=${edge_outbound_ip}" --network "sitecheck-isolated:ip=${edge_ip}" \
  --add-host "web:${web_ip}" -p "127.0.0.1:${bind_port}:8080" --read-only --tmpfs /tmp:rw,size=32m \
  --memory 64m --cpus 0.25 --pids-limit 32 --cap-drop ALL --security-opt no-new-privileges \
  --log-opt max-size=10mb -v "${release_dir}/deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro,Z" \
  docker.io/nginxinc/nginx-unprivileged@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
# CNI's internal bridge deliberately has no host route. Port forwarding must
# select the edge's outbound interface. Permit only this new host-to-edge flow
# through CSF's default-deny OUTPUT policy; no public port is opened.
cat > /opt/sitecheck/firewall.sh <<FIREWALL
#!/usr/bin/env bash
set -e
iptables -C OUTPUT -d ${edge_outbound_ip}/32 -p tcp --dport 8080 -m comment --comment sitecheck-host-edge -j ACCEPT 2>/dev/null || iptables -I OUTPUT 1 -d ${edge_outbound_ip}/32 -p tcp --dport 8080 -m comment --comment sitecheck-host-edge -j ACCEPT
iptables -C INPUT -s ${edge_outbound_ip}/32 -p tcp --sport 8080 -m conntrack --ctstate ESTABLISHED -m comment --comment sitecheck-edge-reply -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -s ${edge_outbound_ip}/32 -p tcp --sport 8080 -m conntrack --ctstate ESTABLISHED -m comment --comment sitecheck-edge-reply -j ACCEPT
FIREWALL
chmod 700 /opt/sitecheck/firewall.sh
/opt/sitecheck/firewall.sh
if [[ -d /etc/csf ]]; then
  if [[ ! -f /etc/csf/csfpost.sh ]]; then printf '#!/bin/sh\n' > /etc/csf/csfpost.sh; fi
  if ! grep -q /opt/sitecheck/firewall.sh /etc/csf/csfpost.sh; then printf '\n[ ! -x /opt/sitecheck/firewall.sh ] || /opt/sitecheck/firewall.sh\n' >> /etc/csf/csfpost.sh; fi
  chmod 700 /etc/csf/csfpost.sh
fi
for name in sitecheck-egress sitecheck-web sitecheck-edge; do
  podman generate systemd --name "$name" --restart-policy=always > "/etc/systemd/system/container-${name}.service"
done
install -d /etc/systemd/system/container-sitecheck-web.service.d /etc/systemd/system/container-sitecheck-edge.service.d
printf '[Unit]\nAfter=container-sitecheck-egress.service\nRequires=container-sitecheck-egress.service\n' > /etc/systemd/system/container-sitecheck-web.service.d/dependencies.conf
printf '[Unit]\nAfter=container-sitecheck-web.service\nRequires=container-sitecheck-web.service\n' > /etc/systemd/system/container-sitecheck-edge.service.d/dependencies.conf
systemctl daemon-reload
podman stop --time 10 sitecheck-edge sitecheck-web sitecheck-egress
systemctl enable --now container-sitecheck-egress.service container-sitecheck-web.service container-sitecheck-edge.service
curl --max-time 5 --retry 5 --retry-connrefused --retry-delay 1 --fail "http://127.0.0.1:${bind_port}/health"
