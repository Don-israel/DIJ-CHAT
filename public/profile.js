
(() => {
    "use strict";

    const $ = selector => document.querySelector(selector);

    let avatarVersion = Date.now();

    function make(tag, className, text) {
        const element = document.createElement(tag);

        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;

        return element;
    }

    async function request(url, method = "GET", body) {
        const response = await fetch(url, {
            method,
            credentials: "same-origin",
            headers: body
                ? { "Content-Type": "application/json" }
                : {},
            ...(body ? {
                body: JSON.stringify(body)
            } : {})
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.error || "Request failed."
            );
        }

        return data;
    }

    function notify(message) {
        const box = $("#toast");

        if (!box) {
            alert(message);
            return;
        }

        box.textContent = message;
        box.classList.add("show");

        setTimeout(() => {
            box.classList.remove("show");
        }, 3000);
    }

    function currentUsername() {
        return $("#profileName")?.textContent.trim() || "";
    }

    function setAvatar(element, username) {
        if (!element || !username) return;

        const key = username + ":" + avatarVersion;

        if (element.dataset.avatarKey === key) return;

        element.dataset.avatarKey = key;
        element.replaceChildren();

        element.append(
            document.createTextNode(
                username.charAt(0).toUpperCase()
            )
        );

        const image = make("img");

        image.alt = "";
        image.draggable = false;

        image.src =
            "/api/avatars/" +
            encodeURIComponent(username) +
            "?v=" + avatarVersion;

        image.onerror = () => image.remove();

        element.append(image);
    }

    function refreshAvatars() {
        const app = $("#appScreen");

        if (!app || app.classList.contains("hidden")) {
            return;
        }

        const username = currentUsername();

        if (username) {
            setAvatar($("#profileAvatar"), username);
        }

        document.querySelectorAll(".conversation")
            .forEach(conversation => {
                const name = conversation.querySelector(
                    ".conversation-name"
                )?.textContent.trim();

                if (name) {
                    setAvatar(
                        conversation.querySelector(".avatar"),
                        name
                    );
                }
            });

        const chatAvatar = $("#chatAvatar");
        const chatName = $("#chatTitle")?.textContent.trim();

        if (
            chatAvatar &&
            !chatAvatar.classList.contains("hidden") &&
            chatName
        ) {
            setAvatar(chatAvatar, chatName);
        }

        document.querySelectorAll(".message-row:not(.mine)")
            .forEach(row => {
                const name = row.querySelector(
                    ".message-sender"
                )?.textContent.trim();

                if (!name) return;

                let avatar = row.querySelector(
                    ".message-avatar"
                );

                if (!avatar) {
                    avatar = make(
                        "div",
                        "avatar message-avatar"
                    );

                    avatar.title = "View profile";
                    avatar.onclick = () => openProfile(name);

                    row.prepend(avatar);
                }

                setAvatar(avatar, name);
            });

        document.querySelectorAll(
            ".result-head"
        ).forEach(head => {
            const name = head.querySelector(
                "strong"
            )?.textContent.trim();

            const messageButton = Array.from(
                head.querySelectorAll("button")
            ).find(button => button.textContent === "Message");

            if (!name || !messageButton) return;

            let avatar = head.querySelector(
                ".social-search-avatar"
            );

            if (!avatar) {
                avatar = make(
                    "div",
                    "avatar social-search-avatar"
                );

                avatar.onclick = () => openProfile(name);
                head.prepend(avatar);
            }

            setAvatar(avatar, name);
        });
    }

    function closeProfile() {
        $("#socialProfileOverlay")?.remove();
    }

    function createModal(title) {
        closeProfile();

        const overlay = make("div", "overlay");
        overlay.id = "socialProfileOverlay";
        overlay.style.zIndex = "150";

        const panel = make("div", "modal");
        const header = make("div", "modal-header");

        const close = make("button", "icon-btn", "✕");

        close.type = "button";
        close.setAttribute("aria-label", "Close profile");
        close.onclick = closeProfile;

        header.append(
            make("h2", "", title),
            close
        );

        panel.append(header);
        overlay.append(panel);

        overlay.onclick = event => {
            if (event.target === overlay) closeProfile();
        };

        document.body.append(overlay);

        return panel;
    }

    async function compressImage(file) {
        if (![
            "image/jpeg",
            "image/png",
            "image/webp"
        ].includes(file.type)) {
            throw new Error(
                "Choose a JPEG, PNG or WebP picture."
            );
        }

        if (file.size > 10 * 1024 * 1024) {
            throw new Error("Maximum file size is 10 MB.");
        }

        const url = URL.createObjectURL(file);

        try {
            const image = new Image();

            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = reject;
                image.src = url;
            });

            const canvas = document.createElement("canvas");

            canvas.width = 384;
            canvas.height = 384;

            const context = canvas.getContext("2d");

            const size = Math.min(
                image.width,
                image.height
            );

            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, 384, 384);

            context.drawImage(
                image,
                (image.width - size) / 2,
                (image.height - size) / 2,
                size,
                size,
                0,
                0,
                384,
                384
            );

            return canvas.toDataURL("image/jpeg", 0.88);

        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async function openProfile(username) {
        if (!username) return;

        const own = username === currentUsername();

        const panel = createModal(
            own ? "My profile" : "User profile"
        );

        const loading = make(
            "p",
            "muted",
            "Loading profile..."
        );

        panel.append(loading);

        try {
            const data = await request(
                "/api/profiles/" +
                encodeURIComponent(username)
            );

            const profile = data.profile;

            loading.remove();

            const content = make("div", "social-profile");
            const cover = make("div", "social-profile-cover");
            const avatar = make("div", "social-avatar");

            setAvatar(avatar, profile.username);

            const identity = make("div", "social-identity");

            identity.append(
                make(
                    "h2",
                    "",
                    profile.display_name || profile.username
                ),
                make("p", "", "@" + profile.username)
            );

            content.append(cover, avatar, identity);

            if (own) {
                const actions = make(
                    "div",
                    "social-photo-actions"
                );

                const fileInput = make("input");

                fileInput.type = "file";
                fileInput.accept =
                    "image/jpeg,image/png,image/webp";
                fileInput.hidden = true;

                const change = make(
                    "button",
                    "btn primary",
                    "Change picture"
                );

                const remove = make(
                    "button",
                    "btn",
                    "Remove picture"
                );

                change.onclick = () => fileInput.click();

                fileInput.onchange = async () => {
                    const file = fileInput.files[0];

                    if (!file) return;

                    change.disabled = true;
                    remove.disabled = true;

                    try {
                        const image = await compressImage(file);

                        await request(
                            "/api/profile/avatar",
                            "POST",
                            { image }
                        );

                        avatarVersion = Date.now();

                        setAvatar(avatar, username);
                        refreshAvatars();

                        notify("Profile picture updated.");

                    } catch (error) {
                        notify(
                            error.message ||
                            "Could not upload picture."
                        );
                    } finally {
                        change.disabled = false;
                        remove.disabled = false;
                        fileInput.value = "";
                    }
                };

                remove.onclick = async () => {
                    if (!confirm("Remove your profile picture?")) {
                        return;
                    }

                    try {
                        await request(
                            "/api/profile/avatar",
                            "DELETE"
                        );

                        avatarVersion = Date.now();

                        setAvatar(avatar, username);
                        refreshAvatars();

                        notify("Profile picture removed.");

                    } catch (error) {
                        notify(error.message);
                    }
                };

                actions.append(change, remove, fileInput);
                content.append(actions);

                const nameField = make("div", "social-field");
                const nameLabel = make("label", "", "DISPLAY NAME");
                const nameInput = make("input");

                nameInput.id = "socialDisplayName";
                nameLabel.htmlFor = nameInput.id;
                nameInput.maxLength = 40;
                nameInput.value = profile.display_name || "";
                nameInput.placeholder = "Your display name";

                nameField.append(nameLabel, nameInput);

                const bioField = make("div", "social-field");
                const bioLabel = make("label", "", "BIO");
                const bioInput = make("textarea");

                bioInput.id = "socialBio";
                bioLabel.htmlFor = bioInput.id;
                bioInput.maxLength = 160;
                bioInput.value = profile.bio || "";
                bioInput.placeholder = "Tell people about yourself.";

                bioField.append(bioLabel, bioInput);

                const save = make(
                    "button",
                    "btn primary social-save",
                    "Save profile"
                );

                save.onclick = async () => {
                    save.disabled = true;

                    try {
                        await request(
                            "/api/profile/update",
                            "POST",
                            {
                                displayName: nameInput.value,
                                bio: bioInput.value
                            }
                        );

                        identity.querySelector("h2").textContent =
                            nameInput.value.trim() || username;

                        notify("Profile saved successfully.");

                    } catch (error) {
                        notify(error.message);
                    } finally {
                        save.disabled = false;
                    }
                };

                content.append(nameField, bioField, save);

            } else {
                content.append(
                    make(
                        "div",
                        "social-bio",
                        profile.bio || "No bio yet."
                    )
                );

                const message = make(
                    "button",
                    "btn primary social-save",
                    "Send message"
                );

                message.onclick = async () => {
                    message.disabled = true;

                    try {
                        await request(
                            "/api/conversations",
                            "POST",
                            { username }
                        );

                        closeProfile();

                        if (typeof loadConversations === "function") {
                            await loadConversations();
                        }

                        const conversation = Array.from(
                            document.querySelectorAll(".conversation")
                        ).find(item =>
                            item.querySelector(
                                ".conversation-name"
                            )?.textContent.trim() === username
                        );

                        if (conversation) {
                            conversation.click();
                        } else {
                            notify("Conversation created. Refresh to view.");
                        }

                    } catch (error) {
                        notify(error.message);
                    } finally {
                        message.disabled = false;
                    }
                };

                content.append(message);
            }

            panel.append(content);

        } catch (error) {
            loading.textContent = error.message;
        }
    }

    // Open your own profile.
    ["profileAvatar", "profileName"].forEach(id => {
        const element = document.getElementById(id);

        if (!element) return;

        element.onclick = () => {
            openProfile(currentUsername());
        };

        element.title = "Edit your profile";
    });

    // View the profile of the person you are chatting with.
    ["chatAvatar", "chatTitle"].forEach(id => {
        const element = document.getElementById(id);

        if (!element) return;

        element.onclick = () => {
            if ($("#chatAvatar")?.classList.contains("hidden")) {
                return;
            }

            openProfile($("#chatTitle")?.textContent.trim());
        };
    });

    const profileContainer = $(".sidebar-bottom");

    if (profileContainer) {
        const edit = make(
            "button",
            "btn social-edit-button",
            "Edit my profile"
        );

        edit.onclick = () => {
            openProfile(currentUsername());
        };

        profileContainer.append(edit);
    }

    // Refresh pictures when existing chat UI changes.
    let scheduled = false;

    const observer = new MutationObserver(() => {
        if (scheduled) return;

        scheduled = true;

        requestAnimationFrame(() => {
            scheduled = false;
            refreshAvatars();
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"]
    });

    // Periodically check for other users' updated pictures.
    setInterval(() => {
        if (document.hidden) return;

        avatarVersion = Date.now();
        refreshAvatars();
    }, 120000);

    refreshAvatars();
})();
