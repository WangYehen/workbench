import subprocess, os, sys

NODE = "/Users/charles/.workbuddy/binaries/node/versions/22.22.2/bin/node"
ROOT = "/Users/charles/WorkBuddy/2026-08-15-20-00-53/team-workbench"
NODE_DIR = os.path.dirname(NODE)


def launch(name, script, log):
    # trap '' HUP 让 node 继承“忽略 SIGHUP”的信号 disposition，
    # start_new_session=True 相当于 setsid，脱离工具进程组/会话，避免被回收/挂断杀掉
    wrapper = ["/bin/sh", "-c", f"trap '' HUP; exec {script}"]
    env = dict(os.environ)
    env["PATH"] = NODE_DIR + ":" + env.get("PATH", "")
    env["HOME"] = os.path.expanduser("~")
    with open(log, "wb") as out:
        p = subprocess.Popen(
            wrapper, cwd=ROOT, stdin=subprocess.DEVNULL,
            stdout=out, stderr=subprocess.STDOUT,
            env=env, start_new_session=True,
        )
    print(f"{name} started pid={p.pid} -> {log}")


if __name__ == "__main__":
    launch("server", f"{NODE} server/index.mjs", "/tmp/twb-server.log")
    launch("client", f"{NODE} {ROOT}/node_modules/.bin/vite", "/tmp/twb-client.log")
    print("done")
