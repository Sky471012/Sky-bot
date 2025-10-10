🧠 Command Reference

🧩 All commands must be sent by a group admin.
The bot ignores messages from non-admins.

🔹 1. !tagall

Description: Mentions every member of the group in chunks of 20.

Usage:

!tagall


Output Example:

@member1 @member2 @member3 ...

🔹 2. !group add <name> @members

Description: Adds mentioned users (or replied users) to a custom subgroup.

Usage:

!group add design @Anurag @Avinash


Alternative (reply method):
Reply to a user’s message and type:

!group add design


✅ Works with real @mentions
✅ Works with LIDs (multi-device IDs) — auto-resolved via participant list
✅ Works via reply method

🔹 3. !group remove <name> @members

Description: Removes mentioned or replied members from a subgroup.

Usage:

!group remove design @Avinash


Alternative:
Reply to a user’s message and type:

!group remove design

🔹 4. !group show <name>

Description: Shows all members inside a subgroup.

Usage:

!group show design


Example Output:

👥 design (2)
@Anurag @Avinash

🔹 5. !group list

Description: Lists all created subgroups in the current WhatsApp group.

Usage:

!group list


Example Output:

🧩 Subgroups
• design (2)
• marketing (3)
• hr (1)

🔹 6. !group delete <name>

Description: Deletes an entire subgroup from the database.

Usage:

!group delete design


Output:

🗑️ Deleted subgroup design.

🔹 7. !tag<name>

Description: Mentions all members inside a particular subgroup.

Usage:

!tagdesign


Example Output:

@Anurag @Avinash


✅ Works for any subgroup name created using !group add
✅ Automatically sends multiple messages if more than 20 members

🔹 8. !help

Description: Displays all available commands and their syntax.

Usage:

!help

⚙️ Admin-Only Rule

All commands are restricted to group admins.
If a non-admin tries, the bot replies:

🚫 Only group admins can use these commands.