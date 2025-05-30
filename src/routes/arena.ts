import express from "express";
import jwt from "jsonwebtoken";
import { docker_queue } from "..";
import authenticate from "../middlewares/authenticate";
import * as fs from "fs/promises";
import * as utils from "../helpers/utils";
import * as COS from "../helpers/cos";
import * as ContConf from "../configs/contest";
import * as ContHasFunc from "../hasura/contest";

const router = express.Router();

/**
 * @param token
 * @param {string} contest_name
 * @param {uuid} map_id
 * @param {TeamLabelBind[]} team_labels
 * @param {number} exposed (0 or 1, default 1)
 * @param {number} envoy (0 or 1, default 1)
 */
router.post("/create", authenticate(), async (req, res) => {
  try {
    const user_uuid = req.auth.user.uuid;
    const contest_name = req.body.contest_name;
    const map_id = req.body.map_id;
    const team_label_binds: ContConf.TeamLabelBind[] = req.body.team_labels;
    const exposed = req.body.exposed ?? 1;
    const envoy = req.body.envoy ?? 1;
    console.debug("user_uuid: ", user_uuid);
    console.debug("contest_name: ", contest_name);
    console.debug("map_id: ", map_id);
    console.debug("team_labels: ", team_label_binds);
    if (
      !contest_name ||
      !team_label_binds ||
      !map_id ||
      !user_uuid ||
      team_label_binds.length < 2
    ) {
      return res
        .status(422)
        .send("422 Unprocessable Entity: Missing credentials");
    }

    // 临时代码，处理 THUAI8 由于 hardcode 导致的 Buddhist 必须在 Monster 前面的 BUG
    const active_team_id = team_label_binds[0].team_id;
    if (contest_name === "THUAI8") {
      const buddhistIndex = team_label_binds.findIndex(
        (bind) => bind.label === "Buddhist",
      );
      const monsterIndex = team_label_binds.findIndex(
        (bind) => bind.label === "Monster",
      );
      if (
        buddhistIndex !== -1 &&
        monsterIndex !== -1 &&
        buddhistIndex > monsterIndex
      ) {
        const temp = team_label_binds[buddhistIndex];
        team_label_binds[buddhistIndex] = team_label_binds[monsterIndex];
        team_label_binds[monsterIndex] = temp;
      }
    }

    const { team_ids, team_labels } = team_label_binds.reduce(
      (acc, team_label_bind) => {
        acc.team_ids.push(team_label_bind.team_id);
        acc.team_labels.push(team_label_bind.label);
        return acc;
      },
      { team_ids: [] as string[], team_labels: [] as string[] },
    );
    console.debug("team_ids: ", team_ids);
    console.debug("team_labels: ", team_labels);

    const contest_id = await ContHasFunc.get_contest_id(contest_name);
    console.debug("contest_id: ", contest_id);
    if (!contest_id) {
      return res.status(400).send("400 Bad Request: Contest not found");
    }

    const arena_settings = await ContHasFunc.get_contest_settings(contest_id);
    const arena_switch = arena_settings?.arena_switch;
    console.debug("arena_switch: ", arena_switch);
    if (!arena_switch) {
      return res.status(403).send("403 Forbidden: Arena is not open");
    }

    const is_manager = await ContHasFunc.get_maneger_from_user(
      user_uuid,
      contest_id,
    );
    console.debug("is_manager: ", is_manager);
    if (!is_manager) {
      const user_team_id = await ContHasFunc.get_team_from_user(
        user_uuid,
        contest_id,
      );
      console.debug("user_team_id: ", user_team_id);
      if (!user_team_id) {
        return res.status(403).send("403 Forbidden: User not in team");
      } else if (user_team_id !== active_team_id) {
        return res.status(403).send("403 Forbidden: User not in team");
      }
    }

    const active_rooms = await ContHasFunc.count_room_team(
      contest_id,
      active_team_id,
    );
    console.debug("active_rooms: ", active_rooms);
    if (active_rooms > 6) {
      return res.status(423).send("423 Locked: Request arena too frequently");
    }

    const players_labels_promises = team_labels.map((team_label) =>
      ContHasFunc.get_players_label(contest_id, team_label),
    );
    const players_labels: string[][] = await Promise.all(
      players_labels_promises,
    );
    console.debug("players_labels: ", players_labels);
    if (players_labels.some((player_labels) => !player_labels)) {
      return res.status(400).send("400 Bad Request: Players_label not found");
    }

    const player_labels_flat = players_labels.flat();
    const team_ids_flat = team_ids.flatMap((team_id, index) =>
      Array(players_labels[index].length).fill(team_id),
    );
    console.debug("player_labels_flat: ", player_labels_flat);
    console.debug("team_ids_flat: ", team_ids_flat);

    const players_details_promises = player_labels_flat.map(
      (player_label, index) =>
        ContHasFunc.get_player_code(team_ids_flat[index], player_label),
    );
    const players_details = await Promise.all(players_details_promises);
    const player_roles_flat = players_details.map(
      (player_detail) => player_detail.role,
    );
    const player_codes_flat = players_details.map(
      (player_detail) => player_detail.code_id,
    );
    console.debug("players_roles_flat: ", player_roles_flat);
    console.debug("players_codes_flat: ", player_codes_flat);
    if (player_codes_flat.some((player_code) => !player_code)) {
      return res.status(403).send("403 Forbidden: Team player not assigned");
    }

    const players_labels_cum = players_labels
      .map((player_labels) => player_labels.length)
      .reduce((acc, val) => {
        acc.push(val + (acc.length > 0 ? acc[acc.length - 1] : 0));
        return acc;
      }, [] as number[]);
    console.debug("players_labels_sum: ", players_labels_cum);
    const players_roles = players_labels_cum.map((player_labels_sum, index) => {
      return player_roles_flat.slice(
        index > 0 ? players_labels_cum[index - 1] : 0,
        player_labels_sum,
      );
    });
    const players_codes = players_labels_cum.map((player_labels_sum, index) => {
      return player_codes_flat.slice(
        index > 0 ? players_labels_cum[index - 1] : 0,
        player_labels_sum,
      );
    });
    console.debug("players_roles: ", players_roles);
    console.debug("players_codes: ", players_codes);

    const code_details_promises = player_codes_flat.map((player_code) =>
      ContHasFunc.get_compile_status(player_code),
    );
    const code_details = await Promise.all(code_details_promises);
    const code_status_flat = code_details.map((code) => code.compile_status);
    const code_languages_flat = code_details.map((code) => code.language);
    console.debug("code_status_flat: ", code_status_flat);
    console.debug("code_languages_flat: ", code_languages_flat);
    if (
      code_status_flat.some(
        (status) => status !== "Completed" && status !== "No Need",
      )
    ) {
      return res.status(403).send("403 Forbidden: Team code not compiled");
    }
    if (
      code_languages_flat.some(
        (language) => language !== "py" && language !== "cpp",
      )
    ) {
      return res
        .status(403)
        .send("403 Forbidden: Team code language not supported");
    }

    console.log("Dependencies checked!");

    res.status(200).send("200 OK: Dependencies checked!");

    const base_directory = await utils.get_base_directory();

    const mkdir_promises = team_ids.map((team_id) => {
      return fs
        .mkdir(`${base_directory}/${contest_name}/code/${team_id}/source`, {
          recursive: true,
        })
        .then(() => {
          return Promise.resolve(true);
        })
        .catch((err) => {
          console.log(`Mkdir ${team_id} failed: ${err}`);
          return Promise.resolve(false);
        });
    });
    const mkdir_result = await Promise.all(mkdir_promises);
    console.debug("mkdir_result: ", mkdir_result);
    if (mkdir_result.some((result) => !result)) {
      // return res.status(500).send("500 Internal Server Error: Code directory creation failed");
      return;
    }

    const files_exist_promises = player_codes_flat.map((player_code, index) => {
      const language = code_languages_flat[index];
      const code_file_name =
        language === "cpp" ? `${player_code}` : `${player_code}.py`;
      return fs
        .access(
          `${base_directory}/${contest_name}/code/${team_ids_flat[index]}/source/${code_file_name}`,
        )
        .then(() => {
          return true;
        })
        .catch(() => {
          return false;
        });
    });
    const files_exist_flat = await Promise.all(files_exist_promises);
    console.debug("files_exist: ", files_exist_flat);

    const player_codes_flat_unique = Array.from(new Set(player_codes_flat));
    const index_map = player_codes_flat_unique.map((player_code) =>
      player_codes_flat.indexOf(player_code),
    );
    console.debug("player_codes_flat_unique: ", player_codes_flat_unique);
    console.debug("index_map: ", index_map);

    if (files_exist_flat.some((file_exist) => !file_exist)) {
      const cos = await COS.initCOS();
      const config = await COS.getConfig();
      const download_promises = player_codes_flat_unique.map(
        (player_code, index) => {
          if (files_exist_flat[index_map[index]]) {
            return Promise.resolve(true);
          }
          const language = code_languages_flat[index_map[index]];
          const code_file_name =
            language === "cpp" ? `${player_code}` : `${player_code}.py`;
          console.debug("code_file_name: ", code_file_name);
          return fs
            .mkdir(
              `${base_directory}/${contest_name}/code/${team_ids_flat[index_map[index]]}/source`,
              { recursive: true },
            )
            .then(() => {
              return COS.downloadObject(
                `${contest_name}/code/${team_ids_flat[index_map[index]]}/${code_file_name}`,
                `${base_directory}/${contest_name}/code/${team_ids_flat[index_map[index]]}/source/${code_file_name}`,
                cos,
                config,
              );
            })
            .then(() => {
              return fs.chmod(
                `${base_directory}/${contest_name}/code/${team_ids_flat[index_map[index]]}/source/${code_file_name}`,
                0o755,
              );
            })
            .then(() => {
              return Promise.resolve(true);
            })
            .catch((err) => {
              console.log(`Download ${code_file_name} failed: ${err}`);
              return Promise.resolve(false);
            });
        },
      );
      const download_results_flat = await Promise.all(download_promises);
      console.debug("download_results: ", download_results_flat);
      if (download_results_flat.some((result) => !result)) {
        // return res.status(500).send("500 Internal Server Error: Code download failed");
        return;
      }
    }

    console.log("Files downloaded!");

    const map_files_count = await fs
      .readdir(`${base_directory}/${contest_name}/map/${map_id}`)
      .then((files) => {
        return files.length;
      })
      .catch((err) => {
        console.log(`Read ${map_id} files failed: ${err}`);
        return -1;
      });
    console.debug("map_files_count: ", map_files_count);

    const map_filename = await ContHasFunc.get_map_name(map_id);
    if (map_files_count > 1) {
      await utils.deleteAllFilesInDir(
        `${base_directory}/${contest_name}/map/${map_id}`,
      );
    }
    if (map_files_count !== 1) {
      await fs.mkdir(`${base_directory}/${contest_name}/map/${map_id}`, {
        recursive: true,
      });
      const cos = await COS.initCOS();
      const config = await COS.getConfig();
      await COS.downloadObject(
        `${contest_name}/map/${map_filename}`,
        `${base_directory}/${contest_name}/map/${map_id}/${map_id}.txt`,
        cos,
        config,
      ).catch((err) => {
        console.log(`Download ${map_id}.txt failed: ${err}`);
        // return res.status(500).send("500 Internal Server Error: Map download failed");
        return;
      });
    }

    console.log("Map downloaded!");

    const files_count_promises = team_ids.map((team_id) => {
      return fs
        .readdir(`${base_directory}/${contest_name}/code/${team_id}/source`)
        .then((files) => {
          return files.length;
        })
        .catch((err) => {
          console.log(`Read ${team_id} files failed: ${err}`);
          return -1;
        });
    });
    const files_count = await Promise.all(files_count_promises);
    console.debug("files_count: ", files_count);
    if (files_count.some((count) => count === -1)) {
      // return res.status(500).send("500 Internal Server Error: Code files count failed");
      return;
    }

    const files_clean_promises = team_ids.map((team_id, index) => {
      if (files_count[index] < 10) {
        return Promise.resolve(true);
      }
      return fs
        .readdir(`${base_directory}/${contest_name}/code/${team_id}/source`)
        .then((files) => {
          const files_stat_promises = files.map((file) => {
            return fs
              .stat(
                `${base_directory}/${contest_name}/code/${team_id}/source/${file}`,
              )
              .then((stat) => {
                return { file, stat };
              });
          });
          return Promise.all(files_stat_promises);
        })
        .then((files_stat) => {
          const files_stat_sorted = files_stat.sort(
            (a, b) => a.stat.mtime.getTime() - b.stat.mtime.getTime(),
          );
          const files_stat_filtered = files_stat_sorted.filter((file_stat) => {
            return !players_codes[index].includes(file_stat.file.split(".")[0]);
          });

          const files_stat_to_delete = files_stat_filtered.slice(
            0,
            files_stat_filtered.length - 3,
          );
          const delete_promises = files_stat_to_delete.map((file_stat) => {
            return fs.unlink(
              `${base_directory}/${contest_name}/code/${team_id}/source/${file_stat.file}`,
            );
          });
          return Promise.all(delete_promises);
        })
        .then(() => {
          return Promise.resolve(true);
        })
        .catch((err) => {
          console.log(`Clean ${team_id} files failed: ${err}`);
          return Promise.resolve(false);
        });
    });
    const files_clean_result = await Promise.all(files_clean_promises);
    console.debug("files_clean: ", files_clean_result);
    if (files_clean_result.some((result) => !result)) {
      // return res.status(500).send("500 Internal Server Error: Code files clean failed");
      return;
    }

    console.log("Files cleaned!");

    const room_id = await ContHasFunc.insert_room(
      contest_id,
      "Waiting",
      map_id,
    );
    console.debug("room_id: ", room_id);
    if (!room_id) {
      // return res.status(500).send("500 Internal Server Error: Room not created");
      return;
    }

    const insert_room_teams_affected_rows = await ContHasFunc.insert_room_teams(
      room_id,
      team_ids,
      team_labels,
      players_roles,
      players_codes,
    );
    if (insert_room_teams_affected_rows !== team_ids.length) {
      // return res.status(500).send("500 Internal Server Error: Room teams not created");
      return;
    }

    console.log("Room created!");

    const copy_promises = player_codes_flat.map((player_code, index) => {
      const language = code_languages_flat[index];
      const code_file_name =
        language === "cpp" ? `${player_code}` : `${player_code}.py`;
      const arena_file_name =
        language === "cpp"
          ? `${player_labels_flat[index]}`
          : `${player_labels_flat[index]}.py`;
      return fs
        .mkdir(
          `${base_directory}/${contest_name}/arena/${room_id}/source/${team_ids_flat[index]}`,
          { recursive: true },
        )
        .then(() => {
          // return fs.copyFile(`${base_directory}/${contest_name}/code/${team_ids_flat[index]}/${code_file_name}`,
          //   `${base_directory}/${contest_name}/arena/${room_id}/source/${team_ids_flat[index]}/${arena_file_name}`)
          return fs.symlink(
            `${base_directory}/${contest_name}/code/${team_ids_flat[index]}/source/${code_file_name}`,
            `${base_directory}/${contest_name}/arena/${room_id}/source/${team_ids_flat[index]}/${arena_file_name}`,
          );
        })
        .then(() => {
          return Promise.resolve(true);
        })
        .catch((err) => {
          console.log(`Copy ${code_file_name} failed: ${err}`);
          return Promise.resolve(false);
        });
    });
    const copy_result = await Promise.all(copy_promises);
    console.debug("copy_result: ", copy_result);
    if (copy_result.some((result) => !result)) {
      // return res.status(500).send("500 Internal Server Error: Code copy failed");
      return;
    }

    console.log("Files copied!");

    docker_queue.push({
      contest_id: contest_id,
      room_id: room_id,
      map_id: map_id,
      team_label_binds: team_label_binds,
      competition: 0,
      exposed: exposed,
      envoy: envoy,
    });

    console.log("Docker pushed!");
    // return res.status(200).send("200 OK: Arena created!");
    return;
  } catch (e) {
    console.error(e);
    // return res.status(500).send("500 Internal Server Error: Unknown error" + e);
    return;
  }
});

/**
 * @param token
 * @param {uuid} team_id
 * @returns {number} score
 */
router.post("/get-score", async (req, res) => {
  try {
    const authHeader = req.get("Authorization");
    if (!authHeader) {
      return res.status(401).send("401 Unauthorized: Missing token");
    }
    const token = authHeader.substring(7);
    return jwt.verify(token, process.env.SECRET!, async (err, decoded) => {
      if (err || !decoded) {
        return res
          .status(401)
          .send("401 Unauthorized: Token expired or invalid");
      }
      const payload = decoded as ContConf.JwtServerPayload;
      const team_label_binds = payload.team_label_binds;
      const team_ids = team_label_binds.map(
        (team_label_bind) => team_label_bind.team_id,
      );

      const scores: number[] = [];
      for (const team_id of team_ids) {
        const score = await ContHasFunc.get_team_arena_score(team_id);
        scores.push(score);
      }

      console.log("score: ", scores);

      return res.status(200).send({
        status: "Finished",
        scores: scores,
      });
    });
  } catch (e) {
    console.error(e);
    return res.status(500).send("500 Internal Server Error: Unknown error" + e);
  }
});

/**
 * @param token
 * @param {utils.ContestResult}
 */
router.post("/finish", async (req, res) => {
  try {
    const authHeader = req.get("Authorization");
    if (!authHeader) {
      return res.status(401).send("401 Unauthorized: Missing token");
    }
    const token = authHeader.substring(7);
    return jwt.verify(token, process.env.SECRET!, async (err, decoded) => {
      if (err || !decoded) {
        return res
          .status(401)
          .send("401 Unauthorized: Token expired or invalid");
      }
      const payload = decoded as ContConf.JwtServerPayload;
      const room_id = payload.room_id;
      const contest_id = payload.contest_id;
      const team_label_binds = payload.team_label_binds;

      const game_scores: number[] = req.body.scores;
      const game_status: string = req.body.status;
      const player_roles: string[][] = req.body.player_roles;
      const extra: string | string[] = req.body.extra;
      const team_ids = team_label_binds.map(
        (team_label_bind) => team_label_bind.team_id,
      );

      console.log("result: ", game_scores);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (game_status === "Finished") {
        console.debug("room_id: ", room_id);
        console.debug("contest_id: ", contest_id);
        console.debug("team_ids: ", team_ids);

        const update_room_team_score_promises = team_ids.map((team_id, index) =>
          ContHasFunc.update_room_team_score(
            room_id,
            team_id,
            game_scores[index],
          ),
        );
        await Promise.all(update_room_team_score_promises);

        await ContHasFunc.update_room_status(room_id, "Finished");
        console.log("Update room team score!");

        if (!player_roles || player_roles.length === 0) {
          return res
            .status(400)
            .send("400 Bad Request: Player roles cannot be empty");
        }
        await ContHasFunc.update_room_team_player_roles(
          room_id,
          team_ids,
          player_roles,
        );
        console.log("Update room team player roles!");
      } else if (game_status === "Crashed") {
        await ContHasFunc.update_room_status(room_id, "Crashed");
        if (player_roles && player_roles.length > 0) {
          await ContHasFunc.update_room_team_player_roles(
            room_id,
            team_ids,
            player_roles,
          );
          console.log("Update room team player roles!");
        }
      }

      const base_directory = await utils.get_base_directory();
      const contest_name = await ContHasFunc.get_contest_name(contest_id);
      try {
        await fs.access(
          `${base_directory}/${contest_name}/arena/${room_id}/output`,
        );
        try {
          const cos = await COS.initCOS();
          const config = await COS.getConfig();
          const file_name = await fs.readdir(
            `${base_directory}/${contest_name}/arena/${room_id}/output`,
          );
          const upload_file_promises = file_name.map((filename) => {
            console.log("filename: " + filename);
            const key = `${contest_name}/arena/${room_id}/${filename}`;
            const localFilePath = `${base_directory}/${contest_name}/arena/${room_id}/output/${filename}`;
            return COS.uploadObject(localFilePath, key, cos, config)
              .then(() => {
                return Promise.resolve(true);
              })
              .catch((err) => {
                console.log(`Upload ${filename} failed: ${err}`);
                return Promise.resolve(false);
              });
          });
          const upload_file = await Promise.all(upload_file_promises);
          if (upload_file.some((result) => !result)) {
            return res
              .status(500)
              .send("500 Internal Server Error: File upload failed");
          }
          console.log("Files uploaded!");

          if (
            extra &&
            ((typeof extra === "string" && extra.trim() !== "") ||
              (Array.isArray(extra) && extra.length > 0))
          ) {
            const extraArray = Array.isArray(extra) ? extra : [extra];
            const extraUploadPromises = extraArray.map((content, index) => {
              const extraFileName = `extra${index + 1}.txt`;
              const localFilePath = `${base_directory}/${contest_name}/arena/${room_id}/output/${extraFileName}`;
              const key = `${contest_name}/arena/${room_id}/${extraFileName}`;
              return fs
                .writeFile(localFilePath, content)
                .then(() => COS.uploadObject(localFilePath, key, cos, config))
                .then(() => {
                  console.log(`Uploaded ${extraFileName} to COS`);
                  return true;
                })
                .catch((err) => {
                  console.log(`Upload ${extraFileName} failed: ${err}`);
                  return false;
                });
            });
            const extraUploadResults = await Promise.all(extraUploadPromises);
            if (extraUploadResults.some((result) => !result)) {
              return res
                .status(500)
                .send("500 Internal Server Error: Extra file upload failed");
            }
            console.log("Extra files uploaded!");
          }
        } catch (err) {
          return res
            .status(500)
            .send("500 Internal Server Error: Upload files failed. " + err);
        }
      } catch (err) {
        console.log("No output files found!");
      } finally {
        const dir_to_remove = `${base_directory}/${contest_name}/arena/${room_id}`;
        console.log("Trying to remove dir: ", dir_to_remove);
        if (await utils.checkPathExists(dir_to_remove)) {
          await utils.deleteAllFilesInDir(dir_to_remove);
          console.log(`Directory deleted: ${dir_to_remove}`);
        } else {
          console.log(
            `Directory not found, skipped deletion: ${dir_to_remove}`,
          );
        }
      }

      return res.status(200).send("200 OK: Update OK!");
    });
  } catch (e) {
    console.error(e);
    return res.status(500).send("500 Internal Server Error: Unknown error" + e);
  }
});

/**
 * @param {uuid} room_id
 * 用于获取回放的路由，直接返回文件。
 */
router.get("/playback/:room_id", async (req, res) => {
  try {
    const room_id = req.params.room_id;

    const { contest_name } = await ContHasFunc.get_room_info(room_id);
    const base_directory = await utils.get_base_directory();
    const playbackLocalPath = `${base_directory}/temp/${room_id}/playback.thuaipb`;
    const playbackCOSPath = `${contest_name}/arena/${room_id}/playback.thuaipb`;

    const cos = await COS.initCOS();
    const config = await COS.getConfig();
    await fs.mkdir(`${base_directory}/temp/${room_id}`, { recursive: true });
    await COS.downloadObject(playbackCOSPath, playbackLocalPath, cos, config);

    res.setHeader(
      "Content-Disposition",
      "attachment;filename=playback.thuaipb",
    );
    res.status(200).sendFile(playbackLocalPath, () => {
      utils.deleteAllFilesInDir(`${base_directory}/temp/${room_id}`);
    });
  } catch (err) {
    console.log(err);
    return res.status(404).send("404 Not Found: Playback not found");
  }
});

export default router;
