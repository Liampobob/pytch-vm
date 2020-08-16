// pytch-gui.js

$(document).ready(function() {
    console.log("pytch-gui: HELLO!");

    ////////////////////////////////////////////////////////////////////////////////
    //
    // Bring some functions into main scope

    const PytchAssetLoadError = (...args) => {
        return new Sk.pytchsupport.PytchAssetLoadError(...args);
    }

    const getElt = (id) => document.getElementById(id);

    const is_undefined = (x) => (typeof x === "undefined");


    ////////////////////////////////////////////////////////////////////////////////
    //

    const Initial_Pytch_Code = "import pytch\n\n";


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Editor interaction

    let ace_editor = ace.edit("editor");

    ace_editor.getSession().setUseWorker(false);
    ace_editor.getSession().setMode("ace/mode/python");
    ace_editor.setValue("import pytch\n"
                        + "from pytch import (\n"
                        + "    Stage,\n"
                        + "    Sprite,\n"
                        + ")\n\n");
    ace_editor.clearSelection();

    let show_code_changed_indicator = (evt => {
        $("#code-change-indicator").show();
    });

    let hide_code_changed_indicator = (evt => {
        $("#code-change-indicator").hide();
    });

    ace_editor.on("change", show_code_changed_indicator);

    let ace_editor_set_code = (code_text => {
        ace_editor.setValue(code_text);
        ace_editor.clearSelection();
        ace_editor.moveCursorTo(0, 0);
    });

    const try_extract_docstring = () => {
        const source = ace_editor.getValue();
        const lines_in_reverse_order = (source
                                        .split("\n")
                                        .reverse()
                                        .map(l => l + "\n"));
        const readline = () => {
            if (lines_in_reverse_order.length === 0)
                throw new Sk.builtin.Exception("EOF");
            return lines_in_reverse_order.pop();
        };

        const filename = "<stdin.py>";
        let tok_idx = 0;
        let docstring = null;
        Sk._tokenize(filename, readline, "utf-8", (tok) => {
            if (tok_idx == 0 && tok.type !== Sk.token.tokens.T_ENCODING) {
                console.log("odd; 0th token wasn't T_ENCODING");
            }
            else if (tok_idx == 1 && tok.type === Sk.token.tokens.T_STRING) {
                const dummy_context = {c_flags: Sk.Parser.CO_FUTURE_UNICODE_LITERALS};
                const [py_docstring, is_f_string] = Sk.parsestr(dummy_context, tok.string);
                docstring = py_docstring.v;
            }
            else {
                // Nothing of interest for us beyond first two tokens.
            }
            tok_idx += 1;
        });

        return docstring;
    }

    const extract_maybe_docstring = () => {
        try {
            return try_extract_docstring();
        } catch {
            return null;
        }
    };


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Live-reload client

    const live_reload_client = (() => {
        let active_ws = null;

        const connect_to_server = () => {
            console.log("connect_to_server(): entering");

            if (active_ws !== null) {
                console.log("already connected");
                return;
            }

            active_ws = new WebSocket("ws://127.0.0.1:4111/");

            active_ws.onerror = (event) => {
                console.log("error from WebSocket");
                active_ws = null;
            };

            active_ws.onmessage = (event) => {
                console.log("got message from server");
                let msg = JSON.parse(event.data);

                switch (msg.kind) {
                case "code": {
                    console.log("code update",
                                msg.tutorial_name, 'len', msg.text.length);
                    Sk.pytch.project_root = `tutorials/${msg.tutorial_name}`;
                    ace_editor.setValue(msg.text);
                    ace_editor.clearSelection();
                    build_button.visibly_build(true);
                    break;
                }
                case "tutorial": {
                    console.log("tutorial update",
                                msg.tutorial_name, 'len', msg.text.length);
                    present_tutorial(new Tutorial(msg.tutorial_name, msg.text));
                    break;
                }
                default:
                    console.log("UNKNOWN update kind", msg.kind);
                }
            };
        };

        return {
            connect_to_server,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Project persistence

    const persistence = (() => {
        const db = new Dexie("pytch");
        //db.delete();

        // TODO: Could we make the code_texts table content-indexes too, i.e.,
        // by SHA256 or similar?  Would cut down on redundancy with copies of
        // tutorial texts, etc.

        db.version(1).stores({
            projects: "++id",
            project_code_versions: "++id, project_id", // Also: seqnum, mtime, code_text_id
            code_texts: "++id", // Also: text
            assets: "oid", // Also: mime_type, data
            project_assets: "++id, project_id", // Also: name_in_project, asset_oid
        });

        const all_table_names = [
            "projects",
            "project_code_versions",
            "code_texts",
            "assets",
            "project_assets",
        ];

        const project_with_code_versions = async (project_id) => {
            const project = await db.projects.get(project_id);
            const code_versions = await (db.project_code_versions
                                         .where("project_id")
                                         .equals(project_id)
                                         .sortBy("seqnum"));
            const latest_version = code_versions[code_versions.length - 1];
            const latest_code = await db.code_texts.get(latest_version.code_text_id);
            return {project, code_versions, latest_text: latest_code.text};
        }

        const create_project = async (name) => {
            const new_project_id = await db.projects.add({name});
            const starting_text_id = await db.code_texts.add({
                text: Initial_Pytch_Code,
            });

            await db.project_code_versions.add({
                project_id: new_project_id,
                seqnum: 1,
                mtime: Date.now(),
                code_text_id: starting_text_id,
            });

            return new_project_id;
        };

        const create_project_from_tutorial = async (project_name, tutorial) => {
            const new_project_id = await create_project(project_name);

            // TODO: More efficient way of doing this than one asset at a time?
            // Or at least provide some feedback?
            for (const path of tutorial.project_asset_paths) {
                let basename = path.substring(path.lastIndexOf('/') + 1);

                const url = `tutorials/${path}`;
                const resp = await fetch(url);
                const mime_type = resp.headers.get("Content-Type");
                const buffer = await resp.arrayBuffer();

                console.log(path, name, mime_type, buffer);
                const add_result = await add_project_asset(new_project_id, basename, mime_type, buffer);
                console.log(add_result);
            }

            return new_project_id;
        };

        const delete_project = async (project_id) => {
            await db.transaction("rw", all_table_names, async () => {
                await db.projects.where("id").equals(project_id).delete();
                await db.project_code_versions.where("project_id").equals(project_id).delete();
                await db.project_assets.where("project_id").equals(project_id).delete();
            });
        };

        const latest_code_version = async (project_id) => {
            const all_versions = await (db.project_code_versions
                                        .where("project_id")
                                        .equals(project_id)
                                        .sortBy("seqnum"));
            console.log(all_versions);
            return all_versions[all_versions.length - 1];
        };

        const latest_code = async (project_id) => {
            const version = await latest_code_version(project_id);
            const code_text_id = version.code_text_id;
            const code_text = await db.code_texts.get(code_text_id);
            console.log(code_text);
            return code_text.text;
        };

        const create_new_code_text_version = async (project_id, text) => {
            // TODO: Tighten transaction scope in terms of which tables it needs?
            const ids = await db.transaction("rw", all_table_names, async () => {
                const current_version = await latest_code_version(project_id);
                const new_seqnum = current_version.seqnum + 1;
                const text_id = await db.code_texts.add({text});
                const version_id = await db.project_code_versions.add({
                    project_id,
                    seqnum: new_seqnum,
                    mtime: Date.now(),
                    code_text_id: text_id,
                });
                return {text_id, version_id};
            });

            return ids;
        };

        // TODO: Think about pagination, scaling when the user has a large
        // number of projects?
        const all_projects = async () => {
            let projects = await db.projects.toArray();
            return projects;
        };

        const str_from_hash = (hash) => {
            const hash_u8s = new Uint8Array(hash);
            let str = "";
            for (let i = 0; i < hash_u8s.length; ++i) {
                let s = hash_u8s[i].toString(16);
                if (s.length == 1)
                    s = "0" + s;
                str += s;
            }
            return str;
        }

        const ensure_have_asset = async (mime_type, data) => {
            console.log(typeof data, data);

            const hash = await window.crypto.subtle.digest({name: "SHA-256"}, data);
            const oid = str_from_hash(hash);

            const maybe_existing_asset = await db.assets.get(oid);

            if (! is_undefined(maybe_existing_asset)) {
                console.log("ensure_have_asset(): returning existing", oid);
                return oid;
            }

            const new_asset = await db.assets.add({oid, mime_type, data});
            console.log("ensure_have_asset(): returning new", oid);
            return oid;
        }

        const project_has_named_asset = async (project_id, name) => {
            const existing_assets = await (db.project_assets
                                           .where("project_id")
                                           .equals(project_id)
                                           .and(pa => pa.name == name)
                                           .toArray());

            const n_existing = existing_assets.length;

            if (n_existing > 1)
                console.log("EEK! More than one!");

            console.log(`found ${n_existing} assets named "${name}" in ${project_id}`);

            const has = (n_existing >= 1);
            console.log("project_has_named_asset():", has);
            return has;
        };

        const add_project_asset = async (project_id, name, mime_type, data) => {
            console.log("add_project_asset():", project_id, name);
            const already_have = await project_has_named_asset(project_id, name);
            console.log("add_project_asset():", already_have)
            if (already_have)
                return {
                    ok: false,
                    reason: `Project already has asset "${name}"`,
                };

            console.log("add_project_asset(): name not dupd; adding data", data);

            const asset_oid = await ensure_have_asset(mime_type, data);
            const project_asset_id = await db.project_assets.add({project_id, name, asset_oid});

            return {
                ok: true,
                project_asset_id,
            };
        };

        const delete_project_asset = async (project_id, asset_oid) => {
            const all_assets = await all_project_assets(project_id);
            const matching_assets = all_assets.filter(pa => pa.asset_oid == asset_oid);

            if (matching_assets.length > 1)
                throw Error(`duplicate asset "${asset_oid}" in ${project_id} (should not happen)`);
            if (matching_assets.length == 0)
                throw Error(`asset "${asset_oid}" not found in ${project_id}`);

            const project_asset = matching_assets[0];
            await db.project_assets.delete(project_asset.id);
        };

        const all_project_assets = async (project_id) => {
            const project_assets = (db.project_assets
                                    .where("project_id")
                                    .equals(project_id)
                                    .sortBy("name"));
            return project_assets;
        };

        const asset_blob = async (oid) => {
            const asset = await db.asset.get(oid);
            const blob = new Blob([asset.data], {type: asset.mime_type});
            return blob;
        };

        const get_project_asset_by_name = async (project_id, name) => {
            // HEM HEM
            name = name.substring(name.lastIndexOf("/") + 1);

            const all_assets = await all_project_assets(project_id);
            const matching_assets = all_assets.filter(pa => pa.name == name);

            if (matching_assets.length > 1)
                throw new Sk.pytchsupport.PytchAssetLoadError(
                    `duplicate asset "${name}" in ${project_id} (should not happen)`,
                    "image-or-sound", name);

            if (matching_assets.length == 0)
                throw new Sk.pytchsupport.PytchAssetLoadError(
                    `asset "${name}" not found in ${project_id}`,
                    "image-or-sound", name);

            const project_asset = matching_assets[0];
            const asset = await db.assets.get(project_asset.asset_oid);

            return asset;
        };

        return {
            project_with_code_versions,
            create_project,
            create_project_from_tutorial,
            delete_project,
            all_projects,
            latest_code,
            create_new_code_text_version,
            add_project_asset,
            delete_project_asset,
            all_project_assets,
            get_project_asset_by_name,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Start page

    const start_page = (() => {
        $("#start-create-project").click(() => {
            $(".pytch-start-info-alert").hide();
            projects_controller.run_modal_creation();
        });

        $("#start-load-existing-project").click(() => {
            $(".pytch-start-info-alert").hide();
            $("#load-existing-alert").show();
            make_tab_current("project-list");
        });

        $("#start-follow-tutorial").click(() => {
            $(".pytch-start-info-alert").hide();
            $("#follow-tutorial-alert").show();
            make_tab_current("tutorial-list");
        });

        return {
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Project and project-set control

    // TODO: Should we inject the dependency on the editor?  Bit clunky to have
    // the global "ace_editor" appearing in there.

    const projects_controller = (() => {
        let active_project_id = null;
        let active_docstring_extraction = null;

        const activate_project = async (project_id) => {
            active_project_id = project_id;

            console.log("activate_project():", project_id);

            const code_text = await persistence.latest_code(project_id);

            ace_editor.setValue(code_text);
            ace_editor.clearSelection();

            refresh_project_info();
        };

        const delete_project_asset = async (asset_oid) => {
            await persistence.delete_project_asset(active_project_id, asset_oid);
        };

        const try_refresh_docstring = () => {
            const maybe_docstring = extract_maybe_docstring();
            if (maybe_docstring !== null)
                $(".project-summary").text(maybe_docstring);
        };

        const schedule_try_refresh_docstring = () => {
            if (active_docstring_extraction !== null)
                window.clearTimeout(active_docstring_extraction);

            // TODO: What's a good timeout here?
            active_docstring_extraction
                = window.setTimeout(try_refresh_docstring, 1000);
        };

        const refresh_project_info = async () => {
            console.log(`refresh_project_info(): entering for ${active_project_id}`);

            $("#start-options-container").hide();
            $("#editor").show();

            $(".placeholder-until-project-loaded").hide();
            $(".active-project-info").show();

            const maybe_docstring = extract_maybe_docstring();
            if (maybe_docstring !== null)
                $(".project-summary").text(maybe_docstring);

            ace_editor.on("change", schedule_try_refresh_docstring);

            const {project, code_versions, latest_text}
                  = await persistence.project_with_code_versions(active_project_id);
            const last_version = code_versions[code_versions.length - 1];
            $(".active-project-info h1").text(project.name);
            // TODO: Something more human-friendly.  Broaden 'mtime' to include
            // when an asset was last added or deleted?
            const mtime_str = new Date(last_version.mtime).toISOString();
            $(".active-project-info p.project-last-modified").text(`Code last modified: ${mtime_str}`);

            // TODO: Update Project info pane with name and assets.  Possibly
            // ability to revert to previous versions.  Needs thought on how
            // this works: is it just a growing collection of snapshots?  A
            // tree?  A list?

            const all_assets = await persistence.all_project_assets(active_project_id);
            console.log(all_assets);

            const asset_list_div = getElt("project-info-asset-list");
            asset_list_div.innerHTML = "";
            all_assets.forEach(a => {
                const asset_div = document.createElement("div");
                $(asset_div).addClass("uk-width-2-3");
                asset_div.innerHTML = (
                    `<h2><code>${a.name}</code></h2>
                     <p>[${a.asset_oid}] TODO: Replace with a thumbnail
                       for images and a 'play' button for sounds.</p>
                     <p class="delete-button-container">
                       <button class="uk-button uk-button-primary uk-button-small">
                         Upload new version (todo)
                       </button>
                       <button class="uk-button uk-button-danger uk-button-small">
                         Delete
                       </button></p>`);
                $(asset_div.querySelectorAll("button")).click(() => delete_asset(a.asset_oid));
                asset_list_div.appendChild(asset_div);
            });

            // TODO: Put project name in tab itself (not pane)?
            make_tab_current("project-info");
        };

        const delete_asset = async (asset_oid) => {
            await persistence.delete_project_asset(active_project_id, asset_oid);
            await refresh_project_info();
        };

        const save_code_text = async () => {
            if (active_project_id === null) {
                console.log("save_code_text(): no active project");
                return;
            }

            const text = ace_editor.getValue();
            const ids = await persistence.create_new_code_text_version(active_project_id, text);
            console.log("saved new code text with IDs", ids);

            UIkit.notification({
                message: `Saved! [ ${ids.text_id} / ${ids.version_id} ]"`,
                status: 'success',
                pos: 'top-center',
                timeout: 3000,
            });
        };

        const create_from_modal = async () => {
            console.log("create_from_modal");

            const name = getElt("new-project-name").value;
            const id = await persistence.create_project(name);
            console.log(`create_from_modal: created project with id ${id}`);

            UIkit.notification({
                message: `Created project "${name}" [${id}]!`,
                status: 'success',
                pos: 'top-center',
                timeout: 3000,
            });

            await my_projects.populate_div(getElt("project-list"));
            activate_project(id);
        };

        const create_project_modal = UIkit.modal(getElt("create-project-modal"));

        const run_modal_creation = () => {
            create_project_modal.show();
        };

        const read_arraybuffer = (file) => {
            return new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onerror = reject;
                fr.onload = () => resolve(fr.result);
                fr.readAsArrayBuffer(file);
            });
        };

        const add_asset_file_input = getElt("add-asset-file-input");

        const add_asset_from_modal = async () => {
            console.log("add_asset_from_modal(): entering");

            const file = add_asset_file_input.files[0];
            const file_buffer = await read_arraybuffer(file);

            const addition_result
                  = await persistence.add_project_asset(active_project_id,
                                                        file.name,
                                                        file.type,
                                                        file_buffer);

            console.log(addition_result);

            if (addition_result.ok)
                UIkit.notification({
                    message: `Added file "${file.name}" [ ${addition_result.project_asset_id} ]`,
                    status: 'primary',
                    pos: 'top-center',
                    timeout: 3000,
                });
            else
                UIkit.notification({
                    message: `Could not add "${file.name}": ${addition_result.reason}`,
                    status: 'warning',
                    pos: 'top-center',
                    timeout: 3000,
                });

            refresh_project_info();

            console.log("add_asset_from_modal(): leaving");
        };

        const add_asset_modal = UIkit.modal(getElt("add-asset-modal"));

        const run_modal_asset_addition = () => {
            add_asset_modal.show();
        };

        // TODO: Show the user what file they've selected.

        $("#asset-add-button").click(add_asset_from_modal);

        const asset_from_name = async (name) => {
            const asset = await persistence.get_project_asset_by_name(active_project_id,
                                                                      name);
            return asset;
        };

        const async_load_image = async (url) => {
            console.log("projects_controller.async_load_image():", url);

            // HEM HEM.
            const name = url.replace(/^project-assets\//, "");
            const asset = await asset_from_name(name);
            console.log("project async_load_image asset", asset);
            const asset_blob = new Blob([asset.data], {type: asset.mime_type});
            const data_url = URL.createObjectURL(asset_blob);
            console.log("project async_load_image", asset_blob, data_url);
            const img = await raw_async_load_image(data_url);

            // TODO: Revoke object URL.

            return img;
        };

        const async_load_buffer = async (tag, url) => {
            console.log("projects_controller.async_load_sound():", tag, url);
            const name = url.replace(/^project-assets\//, "");
            const asset = await asset_from_name(name);
            console.log("project async_load_image asset", asset);
            return asset.data;

        };

        // Button within modal we're in charge of:
        $("#new-project-create").click(create_from_modal);

        return {
            run_modal_creation,
            run_modal_asset_addition,
            activate_project,
            save_code_text,
            async_load_image,
            async_load_buffer,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // "Pytch" menu

    const pytch_menu = (() => {
        $("#pytch-new-project").click(projects_controller.run_modal_creation);
        $("#pytch-save-project").click(projects_controller.save_code_text);
        $("#pytch-parse").click(() => { console.log(extract_maybe_docstring()); });

        return {
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // "My Projects" tab

    const my_projects = (() => {
        const delete_project_if_sure = async (evt, project_id, div) => {
            console.log("delete_project_if_sure():", project_id);
            evt.stopPropagation();

            // TOOD: Check for confirmation

            await persistence.delete_project(project_id);
            await populate_div(div);
        };

        const populate_div = async (div) => {
            const projects = await persistence.all_projects();
            let have_at_least_one_project = false;

            div.innerHTML = "";

            projects.forEach(p => {
                have_at_least_one_project = true;
                let card_elt = document.createElement("div");
                $(card_elt).addClass("uk-width-1-3");
                card_elt.innerHTML = (
                    ('<div class="uk-card uk-card-primary uk-card-hover project-card">'
                     + '<div class="uk-card-header">'
                     + `<h3 class="uk-card-title">${p.name}</h3></div>`
                     + `<div class="uk-card-body"><p>Write a docstring to get a summary for ${p.name}.`
                     + ` Until you do, blah blah blah blah</p></div>`
                     + '<div class="uk-card-footer delete-button-container">'
                     + '<button class="uk-button uk-button-danger uk-button-small">Delete</button>'
                     + '</div>'
                     + '</div>'));
                $(card_elt).click(() => projects_controller.activate_project(p.id));
                $(card_elt).find("button").click((evt) => delete_project_if_sure(evt, p.id, div));
                div.appendChild(card_elt);
            });

            if (have_at_least_one_project)
                $(".placeholder-while-no-projects").hide();
        };

        return {
            populate_div,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // "Project info" tab

    const project_info = (() => {
        $("#add-asset-button").click(projects_controller.run_modal_asset_addition);

        return {
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Very rudimentary auto-completion
    //
    // Only complete "pytch." and "self.", with hard-coded list of options based
    // on the public module functions and base-class methods.

    const pytch_ace_auto_completer = (() => {
        const candidate_from_symbol = (meta) => (symbol) => {
            return {
                name: symbol,
                value: symbol,
                meta: meta,
            };
        };

        const autocompletions_pytch_builtins = [
            "Sprite",
            "Stage",
            "when_green_flag_clicked",
            "when_I_receive",
            "when_key_pressed",
            "when_I_start_as_a_clone",
            "when_this_sprite_clicked",
            "when_stage_clicked",
            "create_clone_of",
            "broadcast",
            "broadcast_and_wait",
            "stop_all_sounds",
            "wait_seconds",
            "key_is_pressed",
        ].map(candidate_from_symbol("pytch built-in"));

        const autocompletions_Actor_methods = [
            "start_sound",
            "play_sound_until_done",
            "go_to_xy",
            "get_x",
            "set_x",
            "change_x",
            "get_y",
            "set_y",
            "change_y",
            "set_size",
            "show",
            "hide",
            "switch_costume",
            "touching",
            "delete_this_clone",
            "move_to_front_layer",
            "move_to_back_layer",
            "move_forward_layers",
            "move_backward_layers",
            "switch_backdrop",
        ].map(candidate_from_symbol("Sprite/Stage method"));

        const getCompletions = (editor, session, pos, prefix, callback) => {
            const cursor_line = session.getLine(pos.row);
            const line_head = cursor_line.substring(0, pos.column);

            if (! line_head.endsWith(prefix)) {
                // TODO: What's the right way to report this error to Ace?
                callback(null, []);
            }

            const pre_prefix_length = line_head.length - prefix.length;
            const pre_prefix = line_head.substring(0, pre_prefix_length);

            const candidates = (
                (pre_prefix.endsWith("pytch.") ? autocompletions_pytch_builtins
                 : (pre_prefix.endsWith("self.") ? autocompletions_Actor_methods
                    : [])));

            callback(null, candidates);
        };

        return {
            getCompletions,
        };
    })();

    ace_editor.setOptions({enableBasicAutocompletion: [pytch_ace_auto_completer]});


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Info tabs (tutorial stdout, errors)

    let make_tab_current_via_evt = (evt => {
        let tab_nub = evt.target.dataset.tab;
        make_tab_current(tab_nub);
    });

    let make_tab_current = (tab_nub => {
        $("#info-panel-tabs p").removeClass("current");
        $("#info-panel-content div.tab-content").removeClass("current");

        $(`#tab-header-${tab_nub}`).addClass("current");
        $(`#tab-pane-${tab_nub}`).addClass("current");

        // Ugly but otherwise it doesn't get the layout right on the first click
        // to this tab.
        if (tab_nub == "project-list")
            UIkit.update(getElt("project-list"));
    });

    $("#info-panel-tabs p").click(make_tab_current_via_evt);


    ////////////////////////////////////////////////////////////////////////
    //
    // Contents of stdout pane

    class TextPane {
        constructor(initial_html, tab_nub) {
            this.initial_html = initial_html;
            this.content_elt = getElt(`tab-content-${tab_nub}`);
            this.reset();
        }

        reset() {
            this.content_elt.innerHTML = this.initial_html;
            this.is_placeholder = true;
        }

        append_text(txt) {
            if (this.is_placeholder) {
                this.content_elt.innerText = txt;
                this.is_placeholder = false;
            } else {
                this.content_elt.innerText += txt;
            }
        }
    }

    let stdout_info_pane = new TextPane(
        "<span class=\"info\">Any output from your script will appear here.</span>",
        "stdout");


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Tutorials

    class Tutorial {
        constructor(name, html, project_asset_paths) {
            this.name = name;
            this.project_asset_paths = project_asset_paths;

            let chapters_elt = document.createElement("div");
            chapters_elt.innerHTML = html;

            this.chapters = (chapters_elt
                             .querySelectorAll("div.tutorial-bundle > div"));
        }

        static async async_create(name) {
            let url = `tutorials/${name}/tutorial.html`;
            let response = await fetch(url);
            let html = await response.text();

            let url1 = `tutorials/${name}/project-assets.json`;
            let resp1 = await fetch(url1);
            let text = await resp1.text();
            let asset_paths = JSON.parse(text);

            console.log("asset_paths", asset_paths);

            return new Tutorial(name, html, asset_paths);
        }

        chapter(chapter_index) {
            return this.chapters[chapter_index];
        }

        get front_matter() {
            return this.chapter(0);
        }

        get maybe_seek_chapter_index() {
            return (+this.front_matter.dataset.seekToChapter) || null;
        }

        code_just_before_chapter(chapter_index) {
            if (chapter_index <= 1)
                return this.initial_code;

            for (let probe_idx = chapter_index - 1;
                 probe_idx > 0;
                 probe_idx -= 1)
            {
                let probe_chapter = this.chapter(probe_idx);
                let patches = probe_chapter.querySelectorAll(".patch-container");
                if (patches.length > 0)
                    return patches[patches.length - 1].dataset.codeAsOfCommit;
            }

            return "import pytch\n";
        }

        chapter_title(chapter_index) {
            let chapter_content = this.chapter(chapter_index);
            let first_h1 = chapter_content.querySelector("div.front-matter > h1");
            if (first_h1 !== null)
                return first_h1.innerText;

            let first_h2 = chapter_content.querySelector("div.chapter-content > h2");
            return first_h2.innerText;
        }

        get initial_code() {
            let front_matter = this.chapters[0];
            return front_matter.dataset.initialCodeText;
        }

        get final_code() {
            let front_matter = this.chapters[0];
            return front_matter.dataset.completeCodeText;
        }

        get n_chapters() {
            return this.chapters.length;
        }
    }

    class TutorialPresentation {
        constructor(tutorial, pane_elt) {
            this.tutorial = tutorial;
            this.chapter_elt = pane_elt.querySelector(".chapter-container");
            this.toc_list_elt = pane_elt.querySelector(".ToC .entries");
            this.chapter_index = this.initial_chapter_index;
            this.populate_toc();
            this.initialise_editor();
            this.refresh();
        }

        populate_toc() {
            this.toc_list_elt.innerHTML = "";
            this.tutorial.chapters.forEach((ch, i) => {
                let toc_entry_elt = document.createElement("li");
                toc_entry_elt.setAttribute("data-chapter-index", i);
                toc_entry_elt.innerHTML = this.tutorial.chapter_title(i);
                $(toc_entry_elt).click((evt) => this.leap_to_chapter_from_event(evt));
                this.toc_list_elt.appendChild(toc_entry_elt);
            });
        }

        /**
          * Value is the one embedded in the tutorial HTML, or 0 if there is no
          * such seek-to-chapter information present.
          */
        get initial_chapter_index() {
            if (this.tutorial.maybe_seek_chapter_index !== null)
                return this.tutorial.maybe_seek_chapter_index;
            return 0;
        }

        leap_to_chapter_from_event(evt) {
            let evt_data = evt.target.dataset;
            this.leap_to_chapter(+evt_data.chapterIndex);
        }

        leap_to_chapter(chapter_index) {
            this.chapter_index = chapter_index;
            this.refresh();
        }

        refresh() {
            this.chapter_elt.innerHTML = "";
            this.chapter_elt.appendChild(this.tutorial.chapter(this.chapter_index));

            if (this.chapter_index == 0)
                this.maybe_augment_front_matter();
            else
                this.maybe_augment_patch_divs();

            this.chapter_elt.scrollTop = 0;

            $(this.toc_list_elt).find("li").removeClass("shown");
            $($(this.toc_list_elt).find("li")[this.chapter_index]).addClass("shown");
        }

        initialise_editor() {
            ace_editor.setValue(this.tutorial.initial_code);
            ace_editor.clearSelection();
        }

        run_final_project() {
            ace_editor.setValue(this.tutorial.final_code);
            ace_editor.clearSelection();
            build_button.visibly_build(true);
        }

        augment_with_navigation(content_elt) {
            let nav_buttons_elt = document.createElement("div");
            $(nav_buttons_elt).addClass("navigation-buttons");

            let on_first_chapter = (this.chapter_index == 0);
            if (! on_first_chapter) {
                let prev_elt = document.createElement("p");
                $(prev_elt).addClass("navigation nav-prev");
                prev_elt.innerHTML = `[back]`;
                $(prev_elt).click(() => this.prev_chapter());
                nav_buttons_elt.appendChild(prev_elt);
            }

            let on_last_chapter = (this.chapter_index == this.tutorial.n_chapters - 1);
            if (! on_last_chapter) {
                let next_elt = document.createElement("p");
                $(next_elt).addClass("navigation nav-next");
                let next_title = this.tutorial.chapter_title(this.chapter_index + 1);
                let next_intro = (this.chapter_index == 0 ? "Let's begin" : "Next");
                next_elt.innerHTML = `${next_intro}: ${next_title}`;
                $(next_elt).click(() => this.next_chapter());
                nav_buttons_elt.appendChild(next_elt);
            }

            content_elt.appendChild(nav_buttons_elt);
        }

        maybe_augment_front_matter() {
            let content_elt = this.chapter_elt.querySelector("div.front-matter");

            if ($(content_elt).hasClass("augmented"))
                return;

            let run_div = content_elt.querySelector("div.run-finished-project");
            if (run_div !== null) {
                let buttons_p = document.createElement("p");
                buttons_p.innerHTML = "Try the project!";
                // Bit of a cheat to re-use 'next page' styling:
                $(buttons_p).addClass("navigation nav-next");
                $(buttons_p).click(() => this.run_final_project());
                run_div.appendChild(buttons_p);
            }

            this.augment_with_navigation(content_elt);

            $(content_elt).addClass("augmented")
        }

        maybe_augment_patch_divs() {
            let content_elt = this.chapter_elt.querySelector("div.chapter-content");

            if ($(content_elt).hasClass("augmented"))
                return;

            let patch_containers = (content_elt
                                    .querySelectorAll("div.patch-container"));

            patch_containers.forEach(div => {
                let patch_div = div.querySelector("div.patch");
                let header_div = document.createElement("h1");
                header_div.innerHTML = "Change the code like this:";
                $(header_div).addClass("decoration");
                div.insertBefore(header_div, patch_div);

                let tbody_add_elts = (patch_div
                                      .querySelectorAll("table > tbody.diff-add"));

                tbody_add_elts.forEach(tbody => {
                    let top_right_td = tbody.querySelector("tr > td:last-child");
                    let copy_div = document.createElement("div");
                    copy_div.innerHTML="<p>COPY</p>";
                    $(copy_div).addClass("copy-button");
                    $(copy_div).click(() => this.copy_added_content(tbody, copy_div));
                    top_right_td.appendChild(copy_div);
                });
            });

            this.augment_with_navigation(content_elt);

            $(content_elt).addClass("augmented");
        }

        async copy_added_content(tbody_elt, copy_button_elt) {
            await navigator.clipboard.writeText(tbody_elt.dataset.addedText);
        }

        next_chapter() {
            this.chapter_index += 1;
            this.refresh();
        }

        prev_chapter() {
            this.chapter_index -= 1;
            this.refresh();
        }
    }

    const tutorials_index = (() => {
        const populate = async () => {
            const index_div = $(".tutorial-list-container")[0];

            const raw_resp = await fetch("tutorials/tutorial-index.html")
            const raw_html = await raw_resp.text();
            index_div.innerHTML = raw_html;

            index_div.querySelectorAll("div.tutorial-summary").forEach(div => {
                const name = div.dataset.tutorialName;
                const present_fun = () => present_tutorial_by_name(name);

                const screenshot_img = div.querySelector("p.image-container > img");
                const raw_src = screenshot_img.getAttribute("src");
                screenshot_img.src = `tutorials/${name}/tutorial-assets/${raw_src}`;
                $(screenshot_img).click(present_fun);

                let try_it_p = document.createElement("p");
                try_it_p.innerText = "Try this tutorial!";
                $(try_it_p).addClass("navigation nav-next");  // Hem hem.
                $(try_it_p).click(present_fun);

                $(div).find("h1").addClass("click-target").click(present_fun);

                div.appendChild(try_it_p);
            });
        };

        return {
            populate,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Populate 'Examples' drop-down menu

    (() => {
        let examples_menu_contents = $('#jq-dropdown-examples > ul');

        let examples = [
            {label: 'Moving Ball', url: 'examples/moving_ball.py'},
            {label: 'Pong', url: 'examples/pong.py'},
            {label: 'Balloon Pop', url: 'examples/balloon_pop.py'},
        ];

        let menubar = $("#editor-menubar");

        let load_example = (async evt => {
            menubar.jqDropdown("hide");

            let evt_data = evt.target.dataset;
            let code_url = evt_data.pytchUrl;
            let code_response = await fetch(code_url);
            let code_text = await code_response.text();
            ace_editor_set_code(code_text);

            let user_project_name = `My ${evt_data.pytchLabel}`;
            user_projects.set_project_name(user_project_name);
        });

        examples.forEach(example => {
            let label_elt = $("<label"
                              + ` data-pytch-url="${example.url}"`
                              + ` data-pytch-label="${example.label}">`
                              + example.label
                              + "</label>");
            $(label_elt).click(load_example);
            let li_elt = $("<li></li>");
            li_elt.append(label_elt);
            examples_menu_contents.append(li_elt);
        });
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Skulpt interaction

    let builtinRead = (fname => {
        if (Sk.builtinFiles === undefined
                || Sk.builtinFiles["files"][fname] === undefined)
            throw Error(`File not found: '${fname}'`);

        return Sk.builtinFiles["files"][fname];
    });


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Provide rendering target and source keyboard events via canvas

    const stage_canvas = (() => {
        const dom_elt = $("#pytch-canvas")[0];

        if (! dom_elt.hasAttribute("tabindex"))
            dom_elt.setAttribute("tabindex", 0);

        const stage_width = dom_elt.width;
        const stage_half_width = (stage_width / 2) | 0;
        const stage_height = dom_elt.height;
        const stage_half_height = (stage_height / 2) | 0;

        const canvas_ctx = dom_elt.getContext("2d");

        canvas_ctx.translate(stage_half_width, stage_half_height);
        canvas_ctx.scale(1, -1);

        const enact_instructions = (rendering_instructions => {
            rendering_instructions.forEach(instr => {
                switch(instr.kind) {
                case "RenderImage":
                    canvas_ctx.save();
                    canvas_ctx.translate(instr.x, instr.y);
                    canvas_ctx.scale(instr.scale, -instr.scale);
                    canvas_ctx.drawImage(instr.image, 0, 0);
                    canvas_ctx.restore();
                    break;

                default:
                    throw Error(`unknown render-instruction kind "${instr.kind}"`);
                }
            });
        });

        const render = (project => {
            canvas_ctx.clearRect(-stage_half_width, -stage_half_height,
                                 stage_width, stage_height);
            enact_instructions(project.rendering_instructions());
        });

        return {
            dom_elt,
            render,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Provide 'keyboard' interface via browser keyboard

    const browser_keyboard = (() => {
        let undrained_keydown_events = [];
        let key_is_down = {};

        const on_key_down = (e => {
            key_is_down[e.key] = true;
            undrained_keydown_events.push(e.key);
            e.preventDefault();
        });

        const on_key_up = (e => {
            key_is_down[e.key] = false;
            e.preventDefault();
        });

        const drain_new_keydown_events = () => {
            let evts = undrained_keydown_events;
            undrained_keydown_events = [];
            return evts;
        };

        const key_is_pressed = (keyname => (key_is_down[keyname] || false));

        return {
            on_key_down,
            on_key_up,
            key_is_pressed,
            drain_new_keydown_events,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Provide 'mouse' interface via browser mouse

    const browser_mouse = (() => {
        const canvas_elt = stage_canvas.dom_elt;
        const stage_hwd = (canvas_elt.width / 2) | 0;
        const stage_hht = (canvas_elt.height / 2) | 0;

        let undrained_clicks = [];
        let client_x = 0.0;
        let client_y = 0.0;

        const on_mouse_move = (evt => {
            client_x = evt.clientX;
            client_y = evt.clientY;
        });

        const current_stage_coords = (() => {
            let elt_rect = canvas_elt.getBoundingClientRect();
            let canvas_x0 = elt_rect.left;
            let canvas_y0 = elt_rect.top;

            let canvas_x = client_x - canvas_x0;
            let canvas_y = client_y - canvas_y0;

            // Recover stage coords by: translating; flipping y.
            let stage_x = canvas_x - stage_hwd;
            let stage_y = stage_hht - canvas_y;

            return { stage_x, stage_y };
        });

        const on_mouse_down = (evt => {
            undrained_clicks.push(current_stage_coords());
        });

        const drain_new_click_events = (() => {
            let evts = undrained_clicks;
            undrained_clicks = [];
            return evts;
        });

        return {
            on_mouse_move,
            on_mouse_down,
            drain_new_click_events,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Provide 'asynchronous load image' interface

    const raw_async_load_image = (url =>
        new Promise((resolve, reject) => {
            let img = new Image();
            img.onload = (() => resolve(img));
            img.onerror = (ignored_error_event => {
                // TODO: Can we tell WHY we couldn't load that image?

                // TODO: This will reveal the within-project-root URL; it would
                // be a better user experience to report just what the user
                // typed, possibly also with the context of the project-root.

                let error_message = `could not load image "${url}"`;
                let py_error = PytchAssetLoadError(error_message, "image", url);

                reject(py_error);
            });
            img.src = url;
        }));


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Sound, SoundPerformance, SoundManager

    class BrowserSoundPerformance {
        constructor(sound) {
            this.tag = sound.tag;
            this.buffer_source = sound.create_buffer_source();

            this.has_ended = false;
            this.buffer_source.onended = () => { this.has_ended = true; };

            this.buffer_source.start();
        }

        stop() {
            this.buffer_source.stop();
            this.has_ended = true;
        }
    }

    class BrowserSound {
        constructor(parent_sound_manager, tag, audio_buffer) {
            this.parent_sound_manager = parent_sound_manager;
            this.tag = tag;
            this.audio_buffer = audio_buffer;
        }

        launch_new_performance() {
            let sound_manager = this.parent_sound_manager;

            let buffer_source = sound_manager.create_buffer_source();
            let performance = new BrowserSoundPerformance(this);
            sound_manager.register_running_performance(performance);

            return performance;
        }

        create_buffer_source() {
            let sound_manager = this.parent_sound_manager;
            let buffer_source = sound_manager.create_buffer_source();
            buffer_source.buffer = this.audio_buffer;
            return buffer_source;
        }
    }

    class BrowserSoundManager {
        constructor() {
            let AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audio_context = new AudioContext();
            this.running_performances = [];
        }

        async async_load_sound(tag, url) {
            const raw_data0 = await projects_controller.async_load_buffer(tag, url);
            let audio_buffer0 = await this.audio_context.decodeAudioData(raw_data0);
            return new BrowserSound(this, tag, audio_buffer0);

            ////////////////////////////////////////////////////////////////

            let err_detail = null;
            let response = null;

            try {
                response = await fetch(url);
                if (! response.ok) {
                    // 404s or similar end up here.
                    err_detail = `status ${response.status} ${response.statusText}`;
                }
            } catch (err) {
                // Network errors end up here.
                err_detail = "network error";
            }

            if (err_detail !== null) {
                let error_message = (`could not load sound "${tag}"`
                                     + ` from "${url}" (${err_detail})`);
                throw PytchAssetLoadError(error_message, "sound", url);
            }

            let raw_data = await response.arrayBuffer();
            let audio_buffer = await this.audio_context.decodeAudioData(raw_data);
            return new BrowserSound(this, tag, audio_buffer);
        }

        register_running_performance(performance) {
            this.running_performances.push(performance);
        }

        stop_all_performances() {
            this.running_performances.forEach(p => p.stop());
            this.running_performances = [];
        }

        one_frame() {
            this.running_performances
                = this.running_performances.filter(p => (! p.has_ended));
        }

        create_buffer_source() {
            let buffer_source = this.audio_context.createBufferSource();
            buffer_source.connect(this.audio_context.destination);
            return buffer_source;
        }
    }

    // Chrome (and possibly other browsers) won't let you create a running
    // AudioContext unless you're doing so in response to a user gesture.  We
    // therefore defer creation and connection of the global Skulpt/Pytch sound
    // manager until first 'BUILD'.  The default Pytch sound-manager has a
    // 'do-nothing' implementation of one_frame(), so we can safely call it in
    // the main per-frame function below.

    let browser_sound_manager = null;

    let ensure_sound_manager = () => {
        if (browser_sound_manager === null) {
            browser_sound_manager = new BrowserSoundManager();
            Sk.pytch.sound_manager = browser_sound_manager;
        }
    };


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Report errors

    let errors_info_pane = (() => {
        let explanation_p = getElt("exceptions-explanation");
        let container_div = getElt("exceptions-container");

        // What 'context', if any, are we currently showing the rich list of
        // errors for?  If none (represented as null), we are showing the
        // explanatory text saying that any errors would appear in that tab.
        let have_error_list_for_context = null;

        // Throw away any previous errors and ensure we are showing the
        // explanation for the tab instead.
        const reset = () => {
            explanation_p.innerHTML = "Any errors in your code will appear here.";
            $(explanation_p).show();

            container_div.innerHTML = "";
            $(container_div).hide();

            have_error_list_for_context = null;
        };

        const error_intro_nub_for_context = (context) => {
            switch (context) {
            case "build":
                return "could not be built";
            case "run":
                return "has stopped";
            default:
                throw Error(`unknown error context ${context}`);
            }
        };

        // Make sure we are showing the <div> containing the rich error reports
        // rather than the explanatory para.  If are already showing the error
        // list, do nothing because there will already be errors there.
        const ensure_have_error_list = (context) => {
            // Have we already set the error-info pane up?  We only want to do
            // so once.
            if (have_error_list_for_context !== null) {
                // If we have already set it up, it should be for the same
                // context (build or run) as we're now being asked for.
                if (have_error_list_for_context !== context)
                    throw Error("already have error info for "
                                + have_error_list_for_context
                                + " but was asked to set one up for "
                                + context);

                return;
            }

            $(explanation_p).hide();

            let intro_div = document.createElement("div");
            let intro_nub = error_intro_nub_for_context(context);
            intro_div.innerHTML = (
                (`<p class=\"errors-intro\">Your project ${intro_nub} because:</p>`
                 + "<ul></ul>"));

            container_div.innerHTML = "";
            container_div.appendChild(intro_div);
            $(container_div).show();

            have_error_list_for_context = context;
        };

        const append_err_li_text = (ul, text) => {
            let li = document.createElement("li");
            li.innerText = text;
            ul.appendChild(li);
            return li;
        };

        const append_err_li_html = (ul, html) => {
            let li = document.createElement("li");
            li.innerHTML = html;
            ul.appendChild(li);
            return li;
        };

        const simple_exception_str = (err => {
            let simple_str = err.tp$name;
            if (err.args && err.args.v.length > 0)
                simple_str += ": " + err.args.v[0].v;
            return simple_str;
        });

        const punch_in_lineno_span = (parent_elt, lineno, give_class) => {
            let span = document.createElement("span");
            span.innerText = `line ${lineno}`;
            if (give_class)
                $(span).addClass("error-loc");
            span.setAttribute("data-lineno", lineno);

            let old_span = parent_elt.querySelector("span");
            parent_elt.replaceChild(span, old_span);
        };

        const append_error = (err, thread_info) => {
            console.log("append_error", err);

            let context = (thread_info === null ? "build" : "run");
            
            ensure_have_error_list(context);

            let err_li = document.createElement("li");
            $(err_li).addClass("one-error");
            err_li.innerHTML = ("<p class=\"intro\"></p>"
                                + "<ul class=\"err-traceback\"></ul>"
                                + "<p>had this problem:</p>"
                                + "<ul class=\"err-message\"></ul>");

            let msg = ((err instanceof Error)
                       ? `Error: ${err.message}`
                       : simple_exception_str(err));

            switch (context) {
            case "build": {
                err_li.querySelector("p.intro").innerHTML = "Your code";

                let err_traceback_ul = err_li.querySelector("ul.err-traceback");
                let n_traceback_frames = err.traceback.length;
                switch (n_traceback_frames) {
                case 0: {
                    // TODO: Can we get some context through to here about
                    // whether we were trying to load images or sounds, or doing
                    // something else?
                    append_err_li_html(err_traceback_ul, "while loading images/sounds");
                    break;
                }
                case 1: {
                    let frame_li = append_err_li_html(err_traceback_ul, "at <span></span>");
                    let frame = err.traceback[0];
                    punch_in_lineno_span(frame_li, frame.lineno, true);
                    break;
                }
                default:
                    console.log(err, thread_info);
                    /* throw Error("expecting empty or single-frame traceback"
                                + " for build error"
                                + ` but got ${n_traceback_frames}-frame one`); */
                }

                let err_message_ul = err_li.querySelector("ul.err-message");
                append_err_li_text(err_message_ul, msg);

                let errors_ul = container_div.querySelector("ul");
                errors_ul.append(err_li);

                break;
            }
            case "run": {
                err_li.querySelector("p.intro").innerHTML
                    = (`A <i>${thread_info.target_class_kind}</i>`
                       + ` of class <i>${thread_info.target_class_name}</i>`);

                let err_traceback_ul = err_li.querySelector("ul.err-traceback");
                err.traceback.forEach((frame, idx) => {
                    let intro = (idx > 0) ? "called by" : "at";
                    let code_origin = (frame.filename == "<stdin>.py"
                                       ? "your code"
                                       : `<em>${frame.filename}</em>`);
                    let frame_li = append_err_li_html(
                        err_traceback_ul, `${intro} <span></span> of ${code_origin}`);
                    punch_in_lineno_span(frame_li, frame.lineno,
                                         (code_origin == "your code"));
                });

                append_err_li_html(err_traceback_ul,
                                   `in the method <code>${thread_info.callable_name}</code>`);
                append_err_li_html(err_traceback_ul,
                                   `running because of <code>${thread_info.event_label}</code>`);

                let err_message_ul = err_li.querySelector("ul.err-message");
                append_err_li_text(err_message_ul, msg);

                let errors_ul = container_div.querySelector("ul");
                errors_ul.append(err_li);

                break;
            }

            default:
                throw Error(`unknown error context ${context}`);
            }

            $(err_li).find(".error-loc").click(go_to_error_location);
        };

        const go_to_error_location = (evt => {
            let lineno = +evt.target.dataset.lineno;
            ace_editor.gotoLine(lineno, 0, true);
        });

        return {
            append_error,
            reset,
        };
    })();

    let report_uncaught_exception = (e, thread_info) => {
        errors_info_pane.append_error(e, thread_info);
        make_tab_current("stderr");
    };


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Build user code

    const build_button =
    (() => {
        const button = $("#build-button");

        const enable = () => {
            (button
             .html("<p>BUILD</p>")
             .removeClass("greyed-out")
             .click(() => visibly_build(false)));
        };

        const disable = () => {
            (button
             .html("<p><i>Working...</i></p>")
             .addClass("greyed-out")
             .off("click"));
        };

        const build = async (then_green_flag) => {
            let code_text = ace_editor.getValue();
            try {
                await Sk.pytchsupport.import_with_auto_configure(code_text);
            } catch (err) {
                report_uncaught_exception(err, null);
            }

            if (then_green_flag)
                Sk.pytch.current_live_project.on_green_flag_clicked();

            stage_canvas.dom_elt.focus();
            enable();
        };

        const immediate_feedback = () => {
            disable();
            stdout_info_pane.reset();
            errors_info_pane.reset();
            hide_code_changed_indicator();
        };

        // If the program is very short, it looks like nothing has happened
        // unless we have a short flash of the "Working..." message.  Split the
        // behaviour into immediate / real work portions.
        const visibly_build = (then_green_flag) => {
            ensure_sound_manager();
            immediate_feedback();
            window.setTimeout(() => build(then_green_flag), 125);
        };

        enable();

        return {
            visibly_build,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Local storage for projects

    let user_projects = (() => {
        let local_storage_key = "pytch-saved-projects";
        let menubar = $("#editor-menubar");
        let user_projects_menu_header = $("#user-projects-menu-header");
        let user_projects_contents = $("#jq-dropdown-user-projects > ul");
        let user_project_name_input = $("#user-chosen-project-name");
        let save_my_project_button = $("#save-my-project-button");

        let saved_project_data = (() => {
            let json_saved_projects = window.localStorage.getItem(local_storage_key);
            return ((json_saved_projects === null)
                    ? []
                    : JSON.parse(json_saved_projects));
        });

        let persist_saved_projects = (project_descriptors => {
            window.localStorage.setItem(local_storage_key,
                                        JSON.stringify(project_descriptors));
        });

        let maybe_project_by_name = ((projects, target_name) => {
            let tgt_idx = projects.findIndex(proj => (proj.name === target_name));

            let next_tgt_idx = projects.findIndex(
                (proj, idx) => ((idx > tgt_idx) && (proj.name === target_name)));

            if (next_tgt_idx !== -1)
                // TODO: More useful error-reporting, even though this is an
                // internal error.
                throw Error(`found "${target_name}" more than once`);

            return (tgt_idx === -1) ? null : projects[tgt_idx];
        });

        let save_project = (() => {
            // TODO: Prompt for confirmation of overwriting if different name
            // to last loaded/saved.

            let project_name = user_project_name_input.val();
            let saved_projects = saved_project_data();
            let project_code_text = ace_editor.getValue();

            let maybe_existing_project
                = maybe_project_by_name(saved_projects, project_name);

            if (maybe_existing_project !== null) {
                let existing_project = maybe_existing_project;
                existing_project.code_text = project_code_text;
            } else {
                saved_projects.push({ name: project_name,
                                      code_text: project_code_text });
            }

            persist_saved_projects(saved_projects);
            refresh();
        });

        let load_project = (evt => {
            menubar.jqDropdown("hide");

            let all_projects = saved_project_data();
            let project_idx = +(evt.target.parentNode.dataset.pytchEntryIdx);
            let project = all_projects[project_idx];
            ace_editor_set_code(project.code_text);
        });

        let highlight_to_be_deleted_project = (evt => {
            let entry_label = $(evt.target.parentNode).find("label");
            entry_label.addClass("cued-for-delete");
        });

        let unhighlight_to_be_deleted_project = (evt => {
            let entry_label = $(evt.target.parentNode).find("label");
            entry_label.removeClass("cued-for-delete");
        });

        let delete_saved_project = (evt => {
            menubar.jqDropdown("hide");
            evt.stopPropagation();

            let all_projects = saved_project_data();
            let project_idx = +(evt.target.parentNode.dataset.pytchEntryIdx);
            all_projects.splice(project_idx, 1);
            persist_saved_projects(all_projects);

            refresh();
        });

        let refresh = (() => {
            user_projects_contents.empty();

            let all_projects = saved_project_data();
            all_projects.forEach((project_descriptor, entry_idx) => {
                let name = project_descriptor.name;

                let li_elt = $("<li></li>");
                li_elt.attr("data-pytch-entry-idx", entry_idx);

                let label_elt = $("<label></label>");
                label_elt.text(name);  // Ensure special chars are escaped.
                label_elt.click(load_project);
                li_elt.append(label_elt);

                let delete_elt = $("<span class=\"delete-button\">DELETE</span>");
                $(delete_elt).click(delete_saved_project);
                $(delete_elt).hover(highlight_to_be_deleted_project,
                                    unhighlight_to_be_deleted_project);
                li_elt.append(delete_elt);

                user_projects_contents.append(li_elt);
            });

            user_projects_menu_header.toggleClass("greyed-out jq-dropdown-ignore",
                                                  (all_projects.length == 0));
        });

        let set_project_name = (name => {
            user_project_name_input.val(name);
        });

        refresh();
        save_my_project_button.click(save_project);

        return {
            set_project_name,
        };
    })();


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Connect Skulpt to our various interfaces

    Sk.configure({
        read: builtinRead,
        output: (txt => stdout_info_pane.append_text(txt)),
        pytch: {
            async_load_image: projects_controller.async_load_image,
            keyboard: browser_keyboard,
            mouse: browser_mouse,
            on_exception: report_uncaught_exception,
        },
    });


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Connect browser events to Pytch handlers

    $("#green-flag").click(() => {
        Sk.pytch.current_live_project.on_green_flag_clicked();
        stage_canvas.dom_elt.focus();
    });

    $("#red-stop").click(() => {
        Sk.pytch.current_live_project.on_red_stop_clicked();
        stage_canvas.dom_elt.focus();
    });

    stage_canvas.dom_elt.onkeydown = browser_keyboard.on_key_down;
    stage_canvas.dom_elt.onkeyup = browser_keyboard.on_key_up;

    stage_canvas.dom_elt.onmousemove = browser_mouse.on_mouse_move;
    stage_canvas.dom_elt.onmousedown = browser_mouse.on_mouse_down;


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Define and launch perpetual Pytch loop

    const one_frame = function() {
        let project = Sk.pytch.current_live_project;

        Sk.pytch.sound_manager.one_frame();
        project.one_frame();
        stage_canvas.render(project);

        window.requestAnimationFrame(one_frame);
    };


    ////////////////////////////////////////////////////////////////////////////////
    //
    // Load example tutorial

    let running_tutorial_presentation = null;

    const present_tutorial = async (tutorial) => {
        const project_id = await persistence.create_project_from_tutorial("My " + tutorial.name,
                                                                          tutorial);
        await projects_controller.activate_project(project_id);
        await my_projects.populate_div(getElt("project-list"));


        // TODO: When to change this back again?
        // Sk.pytch.project_root = `tutorials/${tutorial.name}`;

        running_tutorial_presentation
            = new TutorialPresentation(tutorial,
                                       $("#tab-pane-tutorial")[0]);

        $("#tab-pane-tutorial .placeholder-until-one-chosen").hide();
        $("#tab-pane-tutorial .ToC").show();
        $("#tab-pane-tutorial .chapter-container").show();
        make_tab_current("tutorial");

        let shown_chapter_index = running_tutorial_presentation.chapter_index;
        let code_just_before = tutorial.code_just_before_chapter(shown_chapter_index);
        ace_editor.setValue(code_just_before);
        ace_editor.clearSelection();
        build_button.visibly_build(false);
    };

    const present_tutorial_by_name = async (name) => {
        let tutorial = await Tutorial.async_create(name);
        await present_tutorial(tutorial);
    };

    live_reload_client.connect_to_server();

    const init_everything = async () => {
        await tutorials_index.populate();
        await my_projects.populate_div(getElt("project-list"));
    };

    init_everything().then(
        () => window.requestAnimationFrame(one_frame));
});
