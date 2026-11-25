
/* DIJ CHAT 3.0 — Navigation System */

(() => {
    "use strict";

    const shell = document.getElementById("appShell");

    if (!shell || document.querySelector(".obsidian-rail")) {
        return;
    }

    const icons = {
        chat: `<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l2-4a8.5 8.5 0 1 1 15-4.5Z"/>`,
        add: `<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/>`,
        premium: `<path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z"/>`,
        admin: `<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m9 12 2 2 4-4"/>`,
        theme: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>`,
        logout: `<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M10 12h11m-5-5 5 5-5 5"/>`,
        phone: `<path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3 5.2 2 2 0 0 1 5 3h3a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 2.1l-1.3 1.3a16 16 0 0 0 5.4 5.4l1.3-1.3a2 2 0 0 1 2.1-.6l3 .5a2 2 0 0 1 1.6 1.8Z"/>`,
        video: `<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 5-3v10l-5-3"/>`,
        send: `<path d="m12 19 0-14M5 12l7-7 7 7"/>`
    };

    function svg(name) {
        return `<svg xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true">
            ${icons[name]}
        </svg>`;
    }

    function clickOriginal(id) {
        const button = document.getElementById(id);

        if (button && !button.disabled) {
            button.click();
        }
    }

    const rail = document.createElement("nav");

    rail.className = "obsidian-rail";
    rail.setAttribute("aria-label", "Main navigation");

    const logo = document.createElement("div");
    logo.className = "rail-logo";
    logo.textContent = "D";

    rail.appendChild(logo);

    function addButton(icon, label, action) {
        const button = document.createElement("button");

        button.type = "button";
        button.className = "rail-button";
        button.title = label;
        button.setAttribute("aria-label", label);
        button.innerHTML = svg(icon);
        button.addEventListener("click", action);

        rail.appendChild(button);

        return button;
    }

    const chatButton = addButton(
        "chat",
        "Messages",
        () => {
            shell.classList.remove("chat-open");
            document.getElementById("conversationSearch")?.focus();
        }
    );

    chatButton.classList.add("selected");

    addButton("add", "New conversation", () => {
        clickOriginal("newChatButton");
    });

    addButton("premium", "Premium membership", () => {
        clickOriginal("premiumButton");
    });

    const admin = addButton(
        "admin",
        "Administrator dashboard",
        () => clickOriginal("adminButton")
    );

    admin.classList.add("hidden");

    const spacer = document.createElement("div");
    spacer.className = "rail-spacer";
    rail.appendChild(spacer);

    addButton("theme", "Change appearance", () => {
        clickOriginal("themeButton");
    });

    addButton("logout", "Sign out", () => {
        clickOriginal("logoutButton");
    });

    shell.prepend(rail);

    // Follow the existing administrator permission state.
    const originalAdmin = document.getElementById("adminButton");

    function syncAdmin() {
        admin.classList.toggle(
            "hidden",
            !originalAdmin ||
            originalAdmin.classList.contains("hidden")
        );
    }

    if (originalAdmin) {
        new MutationObserver(syncAdmin).observe(
            originalAdmin,
            {
                attributes: true,
                attributeFilter: ["class"]
            }
        );
    }

    syncAdmin();

    // Replace old text symbols with professional line icons.
    const replacements = [
        ["voiceCallButton", "phone", "Voice call"],
        ["videoCallButton", "video", "Video call"],
        ["sendButton", "send", "Send message"]
    ];

    replacements.forEach(([id, icon, label]) => {
        const button = document.getElementById(id);

        if (!button) return;

        button.innerHTML = svg(icon);
        button.setAttribute("aria-label", label);
        button.title = label;

        const image = button.querySelector("svg");

        image.style.width = "21px";
        image.style.height = "21px";
    });

    document.title = "DIJ CHAT — Obsidian Edition";

    const footer = document.querySelector(".auth-foot");

    if (footer) {
        footer.textContent = "DIJ CHAT / OBSIDIAN EDITION 3.0";
    }

    const welcome = document.querySelector(".welcome h1");

    if (welcome) {
        welcome.textContent = "Your world. Connected.";
    }

    const welcomeText = document.querySelector(".welcome p");

    if (welcomeText) {
        welcomeText.textContent =
            "Find your people, start a conversation, " +
            "and stay connected wherever life takes you.";
    }

    const welcomeLogo = document.querySelector(".welcome-logo");

    if (welcomeLogo) {
        welcomeLogo.innerHTML = svg("chat");

        const image = welcomeLogo.querySelector("svg");

        image.style.width = "48px";
        image.style.height = "48px";
    }
})();
