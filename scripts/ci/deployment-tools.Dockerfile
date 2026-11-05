# Used only by isolated CI acceptance. The privileged Docker socket belongs in
# this disposable operator container, never in an application deployment.
ARG APP_IMAGE=aster:ci
FROM docker:cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS cli
FROM ${APP_IMAGE}
USER root
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY scripts/deploy/backup-volumes.sh /ci/backup-volumes.sh
COPY scripts/ci/deployment-rehearsal.sh /ci/deployment-rehearsal.sh
ENTRYPOINT ["bash"]
