"""
Quién no me sigue de vuelta en Instagram.

Uso:
    python no_me_siguen.py

Las credenciales se piden por consola, o puedes definir las variables
de entorno IG_USERNAME e IG_PASSWORD antes de ejecutar.

La sesión se guarda en session.json para no tener que iniciar sesión
cada vez (Instagram penaliza los logins repetidos).
"""

import getpass
import os
import sys
from pathlib import Path

from instagrapi import Client
from instagrapi.exceptions import (
    BadPassword,
    ChallengeRequired,
    LoginRequired,
    PleaseWaitFewMinutes,
    TwoFactorRequired,
)

BASE_DIR = Path(__file__).resolve().parent
SESSION_FILE = BASE_DIR / "session.json"
OUTPUT_FILE = BASE_DIR / "no_me_siguen.txt"


def get_client() -> Client:
    cl = Client()
    cl.delay_range = [2, 5]  # pausas aleatorias entre peticiones

    username = os.getenv("IG_USERNAME") or input("Usuario de Instagram: ").strip()
    password = os.getenv("IG_PASSWORD") or getpass.getpass("Contraseña: ")

    if SESSION_FILE.exists():
        cl.load_settings(SESSION_FILE)
        try:
            cl.account_info()
            print("Sesión anterior reutilizada.\n")
            return cl
        except LoginRequired:
            print("La sesión caducó, iniciando sesión de nuevo...")

    try:
        cl.login(username, password)
    except TwoFactorRequired:
        code = input("Código de verificación en dos pasos: ").strip()
        cl.login(username, password, verification_code=code)
    except BadPassword:
        sys.exit("Contraseña incorrecta.")
    except ChallengeRequired:
        sys.exit(
            "Instagram pide verificar que eres tú. Abre la app o el navegador, "
            "confirma el inicio de sesión y vuelve a ejecutar el script."
        )

    cl.dump_settings(SESSION_FILE)
    print("Sesión guardada.\n")
    return cl


def main() -> None:
    cl = get_client()

    try:
        print("Descargando lista de seguidores...")
        followers = cl.user_followers(cl.user_id)
        print(f"  {len(followers)} seguidores.")

        print("Descargando lista de seguidos...")
        following = cl.user_following(cl.user_id)
        print(f"  {len(following)} seguidos.\n")
    except PleaseWaitFewMinutes:
        sys.exit("Instagram está limitando las peticiones. Espera unos minutos y reintenta.")

    followers_by_pk = {u.pk: u for u in followers.values()}
    following_by_pk = {u.pk: u for u in following.values()}

    no_me_siguen = sorted(
        (following_by_pk[pk] for pk in following_by_pk.keys() - followers_by_pk.keys()),
        key=lambda u: u.username.lower(),
    )
    no_los_sigo = sorted(
        (followers_by_pk[pk] for pk in followers_by_pk.keys() - following_by_pk.keys()),
        key=lambda u: u.username.lower(),
    )

    print(f"Te siguen mutuamente: {len(followers_by_pk.keys() & following_by_pk.keys())}")
    print(f"Sigues y NO te siguen de vuelta: {len(no_me_siguen)}")
    for u in no_me_siguen:
        print(f"  @{u.username} ({u.full_name})")
    print(f"Te siguen y tú NO les sigues: {len(no_los_sigo)}\n")

    with OUTPUT_FILE.open("w", encoding="utf-8") as f:
        f.write("NO ME SIGUEN DE VUELTA\n")
        f.write("=" * 40 + "\n")
        for u in no_me_siguen:
            f.write(f"@{u.username}\t{u.full_name}\thttps://instagram.com/{u.username}\n")
        f.write("\nTE SIGUEN Y NO LES SIGUES\n")
        f.write("=" * 40 + "\n")
        for u in no_los_sigo:
            f.write(f"@{u.username}\t{u.full_name}\thttps://instagram.com/{u.username}\n")

    print(f"Lista completa guardada en: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
