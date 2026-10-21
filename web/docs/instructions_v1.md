# Study instructions and annotation guidelines

**Study:** [[STUDY TITLE]]

## Purpose
We are studying whether an AI segmentation model can learn from the corrections clinicians make and become more useful for future cases. You do not need any programming or AI experience.

## Your task for every image
1. Examine the image and the outline drawn by the model.
2. If the model missed part of the target structure, select **+ Missing region** and click inside the missing area.
3. If the model included an area that does not belong, select **&minus; False region** and click inside that area.
4. The model updates its outline. Inspect the new result.
5. Repeat until the outline is clinically acceptable, then click **Accept mask**.
6. If clicks cannot give an acceptable outline, use **Manual correction** to draw it yourself, or **Flag case**.
7. Rate your confidence in the final outline and the difficulty of the case.

## What the target is
[[DEFINITION OF THE TARGET STRUCTURE AND WHAT COUNTS AS A CLINICALLY ACCEPTABLE BOUNDARY]]

## Please note
- Use your own clinical judgment. There is no fixed number of clicks.
- Do not accept an incorrect outline to finish quickly.
- Some cases use the original model and others a model trained on earlier corrections. You do not need to tell them apart, and you will not be told which is which.
- Time, clicks and decisions are recorded automatically. The timer pauses when you press Pause, switch to another tab, or stop interacting for 45 seconds.
- You can zoom with the mouse wheel and pan with a right-click drag or Shift and drag. Keys: P for +, N for &minus;, Z to undo, O to hide the outline.
- Do not use the browser's back button during a case. If your connection drops or you close the page, sign in again and the same case reopens.
- You may stop at any time and continue later. Cases are shown in a fixed order.

## The first cases are practice
The first few cases are practice cases so that you can learn the tool. They are recorded but not part of the main analysis.

By signing I confirm that I have read these instructions and understand the task.
