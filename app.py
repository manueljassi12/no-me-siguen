"""
App para ver quién no te sigue de vuelta en Instagram.

Uso:
    python app.py
"""

import threading
import webbrowser
from pathlib import Path
from tkinter import messagebox

import customtkinter as ctk
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

BG = "#FBF3F7"
CARD = "#FFFFFF"
ROW = "#FDF8FB"
ACCENT = "#E98FB2"
ACCENT_HOVER = "#D97BA1"
ACCENT_SOFT = "#F0D7E3"
ACCENT_TEXT = "#B2577E"
TEXT = "#4A3B42"
MUTED = "#9A8A92"
ERROR = "#D16666"
FONT = "Segoe UI"


class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Follow Check")
        self.geometry("460x700")
        self.minsize(420, 620)
        self.configure(fg_color=BG)
        ctk.set_appearance_mode("light")
        self._build_login()

    # ------------------ vista de login ------------------

    def _entry(self, parent, placeholder, show=None):
        e = ctk.CTkEntry(
            parent, placeholder_text=placeholder, show=show,
            font=(FONT, 13), height=40, corner_radius=12,
            fg_color=ROW, border_color="#F0DCE7", text_color=TEXT,
        )
        e.pack(fill="x", padx=20, pady=(12, 0))
        return e

    def _build_login(self):
        self.login_frame = ctk.CTkFrame(self, fg_color="transparent")
        self.login_frame.pack(fill="both", expand=True, padx=24, pady=24)

        ctk.CTkLabel(self.login_frame, text="♡", font=(FONT, 64),
                     text_color=ACCENT).pack(pady=(40, 0))
        ctk.CTkLabel(self.login_frame, text="¿Quién no te sigue?",
                     font=(FONT, 22, "bold"), text_color=TEXT).pack()
        ctk.CTkLabel(self.login_frame, text="Descúbrelo en un clic",
                     font=(FONT, 13), text_color=MUTED).pack(pady=(0, 24))

        card = ctk.CTkFrame(self.login_frame, fg_color=CARD, corner_radius=18)
        card.pack(fill="x", padx=10)

        self.user_entry = self._entry(card, "Usuario de Instagram")
        self.pass_entry = self._entry(card, "Contraseña", show="•")
        self.code_entry = self._entry(card, "Código 2FA (solo si lo tienes activado)")

        self.progress = ctk.CTkProgressBar(
            card, fg_color="#F3E4EC", progress_color=ACCENT,
            mode="indeterminate", corner_radius=8)

        self.status = ctk.CTkLabel(card, text="", font=(FONT, 12),
                                   text_color=MUTED, wraplength=340)
        self.status.pack(pady=(12, 0))

        self.login_btn = ctk.CTkButton(
            card, text="Entrar y analizar", font=(FONT, 14, "bold"),
            fg_color=ACCENT, hover_color=ACCENT_HOVER, text_color="white",
            corner_radius=14, height=44, command=self._on_login)
        self.login_btn.pack(fill="x", padx=20, pady=18)

    def _on_login(self):
        username = self.user_entry.get().strip()
        password = self.pass_entry.get()
        code = self.code_entry.get().strip()
        if not username or not password:
            self.status.configure(text="Escribe tu usuario y contraseña",
                                  text_color=ERROR)
            return
        self.login_btn.configure(state="disabled")
        self.progress.pack(fill="x", padx=20, pady=(12, 0))
        self.progress.start()
        threading.Thread(target=self._worker,
                         args=(username, password, code), daemon=True).start()

    # ------------------ lógica (hilo en segundo plano) ------------------

    def _status(self, msg, error=False):
        self.after(0, lambda: self.status.configure(
            text=msg, text_color=ERROR if error else MUTED))

    def _fail(self, msg):
        self.after(0, self._reset_login, msg)

    def _reset_login(self, msg):
        self.progress.stop()
        self.progress.pack_forget()
        self.login_btn.configure(state="normal")
        self.status.configure(text=msg, text_color=ERROR)

    def _worker(self, username, password, code):
        try:
            cl = Client()
            cl.delay_range = [2, 5]

            if SESSION_FILE.exists():
                cl.load_settings(SESSION_FILE)
                try:
                    cl.account_info()
                    self._status("Sesión reutilizada ♡")
                except LoginRequired:
                    self._status("Sesión caducada, entrando de nuevo...")
                    self._do_login(cl, username, password, code)
            else:
                self._status("Iniciando sesión...")
                self._do_login(cl, username, password, code)

            self._status("Descargando seguidores...")
            followers = cl.user_followers(cl.user_id)
            self._status("Descargando seguidos...")
            following = cl.user_following(cl.user_id)

            fers = {u.pk: u for u in followers.values()}
            fing = {u.pk: u for u in following.values()}
            data = {
                "mutuos": len(fers.keys() & fing.keys()),
                "no_me_siguen": sorted(
                    (fing[p] for p in fing.keys() - fers.keys()),
                    key=lambda u: u.username.lower()),
                "no_los_sigo": sorted(
                    (fers[p] for p in fers.keys() - fing.keys()),
                    key=lambda u: u.username.lower()),
            }
            self.after(0, self._show_results, data)

        except BadPassword:
            self._fail("Contraseña incorrecta.")
        except TwoFactorRequired:
            self._fail("Instagram pide tu código 2FA — escríbelo en el campo y reintenta.")
        except ChallengeRequired:
            self._fail("Confirma el inicio de sesión en tu app de Instagram y reintenta.")
        except PleaseWaitFewMinutes:
            self._fail("Instagram te está limitando. Espera unos minutos y reintenta.")
        except Exception as e:
            self._fail(f"Error: {e}")

    def _do_login(self, cl, username, password, code):
        cl.login(username, password, verification_code=code)
        cl.dump_settings(SESSION_FILE)
        self._status("Sesión guardada ♡")

    # ------------------ vista de resultados ------------------

    def _stat(self, parent, label, value, col):
        parent.columnconfigure(col, weight=1)
        c = ctk.CTkFrame(parent, fg_color=CARD, corner_radius=14)
        c.grid(row=0, column=col, padx=5, sticky="nsew")
        ctk.CTkLabel(c, text=str(value), font=(FONT, 22, "bold"),
                     text_color=ACCENT).pack(pady=(12, 0))
        ctk.CTkLabel(c, text=label, font=(FONT, 11),
                     text_color=MUTED).pack(pady=(0, 12))

    def _fill_list(self, parent, users):
        scroll = ctk.CTkScrollableFrame(parent, fg_color="transparent")
        scroll.pack(fill="both", expand=True, padx=4, pady=4)
        if not users:
            ctk.CTkLabel(scroll, text="Nadie por aquí ♡",
                         font=(FONT, 13), text_color=MUTED).pack(pady=30)
            return
        for u in users:
            row = ctk.CTkFrame(scroll, fg_color=ROW, corner_radius=10)
            row.pack(fill="x", pady=3, padx=2)
            ctk.CTkButton(
                row, text="Ver", width=52, height=26, font=(FONT, 11, "bold"),
                fg_color=ACCENT_SOFT, hover_color="#E5C4D6",
                text_color=ACCENT_TEXT, corner_radius=10,
                command=lambda u=u: webbrowser.open(
                    f"https://instagram.com/{u.username}"),
            ).pack(side="right", padx=8)
            ctk.CTkLabel(row, text=f"@{u.username}", font=(FONT, 13, "bold"),
                         text_color=TEXT).pack(side="left", padx=(12, 6), pady=8)
            ctk.CTkLabel(row, text=u.full_name or "", font=(FONT, 12),
                         text_color=MUTED).pack(side="left")

    def _export(self, data):
        with OUTPUT_FILE.open("w", encoding="utf-8") as f:
            f.write("NO ME SIGUEN DE VUELTA\n" + "=" * 40 + "\n")
            for u in data["no_me_siguen"]:
                f.write(f"@{u.username}\t{u.full_name}\n")
            f.write("\nTE SIGUEN Y NO LES SIGUES\n" + "=" * 40 + "\n")
            for u in data["no_los_sigo"]:
                f.write(f"@{u.username}\t{u.full_name}\n")
        messagebox.showinfo("Exportado", f"Lista guardada en:\n{OUTPUT_FILE}")

    def _show_results(self, data):
        self.login_frame.destroy()
        frame = ctk.CTkFrame(self, fg_color="transparent")
        frame.pack(fill="both", expand=True, padx=20, pady=20)

        ctk.CTkLabel(frame, text="♡ Resultados ♡",
                     font=(FONT, 20, "bold"), text_color=TEXT).pack()

        stats = ctk.CTkFrame(frame, fg_color="transparent")
        stats.pack(fill="x", pady=14)
        self._stat(stats, "Mutuos", data["mutuos"], 0)
        self._stat(stats, "No me siguen", len(data["no_me_siguen"]), 1)
        self._stat(stats, "No los sigo", len(data["no_los_sigo"]), 2)

        tabs = ctk.CTkTabview(
            frame, fg_color=CARD, corner_radius=16, text_color=TEXT,
            segmented_button_fg_color="#F3E4EC",
            segmented_button_selected_color=ACCENT,
            segmented_button_selected_hover_color=ACCENT_HOVER,
            segmented_button_unselected_color="#F3E4EC",
            segmented_button_unselected_hover_color="#EBD6E2",
        )
        tabs.pack(fill="both", expand=True, pady=6)
        self._fill_list(tabs.add("No me siguen"), data["no_me_siguen"])
        self._fill_list(tabs.add("Fans"), data["no_los_sigo"])

        bottom = ctk.CTkFrame(frame, fg_color="transparent")
        bottom.pack(fill="x", pady=(12, 0))
        ctk.CTkButton(
            bottom, text="Exportar .txt", font=(FONT, 13, "bold"),
            fg_color=ACCENT_SOFT, hover_color="#E5C4D6", text_color=ACCENT_TEXT,
            corner_radius=14, height=40,
            command=lambda: self._export(data),
        ).pack(side="left", expand=True, fill="x", padx=(0, 6))
        ctk.CTkButton(
            bottom, text="Cerrar", font=(FONT, 13, "bold"),
            fg_color=ACCENT, hover_color=ACCENT_HOVER, text_color="white",
            corner_radius=14, height=40, command=self.destroy,
        ).pack(side="left", expand=True, fill="x", padx=(6, 0))


if __name__ == "__main__":
    App().mainloop()
